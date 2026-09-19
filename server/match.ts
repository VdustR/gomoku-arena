/**
 * Authoritative match state.
 *
 * The board lives here, not in a browser tab, so a person and two agents can
 * all act on the same game. Every mutation goes through `play`, which is the
 * only place a stone is ever added, and which validates against the same
 * `src/lib/rules.js` the page uses.
 *
 * Legality is enforced here rather than by narrowing what a player is offered.
 * A caller may name any point; an illegal one is refused with a reason and
 * costs no turn.
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SIZE,
  BLACK,
  WHITE,
  EMPTY,
  createBoard,
  idx,
  inBounds,
  coordLabel,
  moveLegality,
  resolveMove,
  winningLine,
  RULE_SETS,
  FORBIDDEN_COPY,
} from '../src/lib/rules.ts'
import type { Board, IllegalReason, Point, RuleSetId, Side } from '../src/lib/rules.ts'
import { candidateMoves } from '../src/lib/ai/heuristic.ts'
import { FORMAT_VERSION, readRecord } from './record.ts'
import type {
  Hold,
  Rewind,
  StoredMatch,
  StoredMetrics,
  StoredMove,
  StoredRefusal,
  StoredSeat,
} from './record.ts'

/**
 * The live match, as opposed to the stored one.
 *
 * Two types for one thing on purpose. `StoredMatch` in `record.ts` holds what
 * a file may contain; everything below that is not also in `StoredMatch` —
 * the board, the side to move, the status, the winner, the winning stones,
 * the turn clock — is produced by `replay` and must never be written. The
 * stored schema is strict, so writing one of them is a load failure rather
 * than a convention nobody checked.
 */
export interface MatchState {
  id: string
  ruleSet: RuleSetId
  seats: Record<Side, StoredSeat>
  history: StoredMove[]
  rejected: Record<Side, StoredRefusal[]>
  rewind: Rewind | null
  paused: Hold | null
  createdAt: string
  updatedAt: string
  version: number
  // Replayed, never stored.
  board: Board
  turn: Side
  status: ReplayedStatus
  winner: Side | null
  winningStones: Point[]
  turnStartedAt: number
}

/** How a game stands once its moves are replayed. A hold is not in here. */
export type ReplayedStatus = 'playing' | 'win' | 'draw'
/** What anyone outside this module sees, with a hold folded in. */
export type PublicStatus = ReplayedStatus | 'paused'

declare const written: unique symbol

/**
 * A match whose current state is on disk.
 *
 * The brand has one producer, `persist`, and every function that hands a
 * match back to a caller returns it. `getMatch` deliberately returns the
 * unbranded `MatchState`, which is what makes the guarantee real: a path
 * that changes a match and returns it without writing does not compile.
 * Checked by making `resetMatch` skip `notify` — with `getMatch` returning
 * `Saved` it compiled happily, which is the version that would have shipped
 * a guarantee that was not one.
 *
 * What it does not catch is a mutation made and then dropped rather than
 * returned; TypeScript cannot see through an in-place write. That is the
 * refusal path, and `refuse()` is the answer to it: one function, and it
 * writes. The mistake this pair exists for is real — a refusal changes no
 * stone, so it never reaches `notify`, and a record was lost before a test
 * caught it.
 */
export type Saved = MatchState & { readonly [written]: true }

/**
 * What a caller is allowed to see.
 *
 * One contract with two halves: this is written here and read by the page's
 * `applyState`. Naming it means the two cannot drift silently — a field added
 * on one side and missed on the other is a type error rather than a value
 * that is quietly `undefined` on screen.
 */
export interface PublicMove {
  n: number
  seat: SeatName
  point: string
  by: string | null
  note: string | null
  thinkingMs: number
  latencyMs: number | null
  metrics: StoredMetrics
  rejected: StoredRefusal[]
}

export interface Candidate {
  point: string
  rationale: string
}

export interface PublicMatch {
  id: string
  version: number
  ruleSet: RuleSetId
  ruleSummary: string
  status: PublicStatus
  paused: Hold | null
  winner: SeatName | null
  winningStones: string[]
  turn: SeatName
  /** Null when the caller did not name a seat, so nothing is claimed for it. */
  yourTurn: boolean | null
  seats: Record<SeatName, StoredSeat>
  moves: number
  board: {
    size: number
    ascii: string
    black: string[]
    white: string[]
    cells: number[]
  }
  history: PublicMove[]
  updatedAt: string
  /** Present only while a take-back is still the most recent change. */
  rewound?: Omit<Rewind, 'movesAt'>
  /** Present only when this seat asked for a shortlist, or was given one. */
  candidates?: Candidate[]
}

const COLUMNS = 'ABCDEFGHJKLMNOPQRSTUVWXYZ'
/*
 * Two caps, because the two kinds of record are not worth the same.
 *
 * `MAX_MATCHES` is the live working set: games still being played. It used to
 * be the cap on everything, which meant fifty new boards quietly deleted a
 * finished game someone meant to review — undoing the promise New game makes
 * by leaving the previous match behind at its own id.
 *
 * A finished record is small, is the one anyone goes back to, and gets a cap
 * of its own.
 */
const MAX_MATCHES = Number(process.env['GOMOKU_MAX_MATCHES'] ?? 50) || 50
const MAX_FINISHED = Number(process.env['GOMOKU_MAX_FINISHED'] ?? 200) || 200

/**
 * What a player could tell us about a move varies by what the player is, so
 * the record keeps whatever each one can actually produce rather than forcing
 * one shape. `source` says where a number came from, because a search engine
 * counting its own nodes and an agent reporting its own token use are not
 * evidence of the same quality.
 */
const METRIC_SOURCES = new Set(['measured', 'reported'])

/** Seat names as everyone outside this module spells them. */
export type SeatName = 'black' | 'white'
export const SEATS: Record<SeatName, Side> = { black: BLACK, white: WHITE }
export const seatName = (color: Side): SeatName => (color === BLACK ? 'black' : 'white')

/**
 * The status anyone outside this module sees.
 *
 * `match.status` is replayed from the moves and only ever says how the game
 * stands. A hold is not in the moves, so it is stored separately and folded
 * in here: a game waiting for a player who is coming back reads as held
 * rather than as one nobody has touched for an hour.
 */
export const isRuleSet = (value: string): value is RuleSetId => value in RULE_SETS

export const statusOf = (match: MatchState): PublicStatus =>
  match.paused && match.status === 'playing' ? 'paused' : match.status

/*
 * Matches survive a restart.
 *
 * They used to live only in memory, so reloading the dev server — which a
 * source edit does on its own — ended every game in progress. Two agents
 * mid-match have no way to recover from that, and no reason to expect it.
 *
 * One small JSON file per match, written on every change. At this size that
 * is cheaper than anything with a schema, and a corrupt or hand-edited file
 * costs one match rather than the whole store.
 */
const STORE = process.env['GOMOKU_STATE_DIR']
  ? resolve(process.env['GOMOKU_STATE_DIR'])
  : resolve(fileURLToPath(new URL('../.matches', import.meta.url)))

const matches = new Map<string, Saved>()
/** Wakes a held call. The argument says why, when it is not simply the turn. */
type Wake = (interrupted?: string | null) => void
/** Resolvers waiting for a seat's turn, keyed by `${matchId}:${color}`. */
const waiters = new Map<string, Wake[]>()
/** Subscribers to any change in a match, for the browser's event stream. */
type Send = (view: PublicMatch) => void
const watchers = new Map<string, Send[]>()

const fileFor = (id: string): string => join(STORE, `${id}.json`)

/*
 * The move list is the record; everything else is a view of it.
 *
 * The board, whose turn it is, who won and the frames a review steps through
 * are all reachable by replaying the moves, so storing them too would be two
 * versions of one fact that can disagree. What cannot be derived — the rules
 * in force, who held each seat, what each player said and what the board
 * refused — is what gets written.
 *
 * This also makes a saved file portable: drop one into the state directory
 * and the match is playable and reviewable again.
 */
const toStored = (match: MatchState): StoredMatch => ({
  // Which shape this is, so a reader never has to infer it from its contents.
  formatVersion: FORMAT_VERSION,
  id: match.id,
  ruleSet: match.ruleSet,
  seats: match.seats,
  history: match.history,
  rejected: match.rejected,
  rewind: match.rewind,
  paused: match.paused,
  createdAt: match.createdAt,
  updatedAt: match.updatedAt,
  version: match.version,
})

/** Rebuild the derived state by replaying the moves through the same rules. */
export function replay({
  id,
  ruleSet,
  seats,
  history,
  rejected,
  rewind,
  paused,
  createdAt,
  updatedAt,
  version,
}: StoredMatch): MatchState {
  // `formatVersion` is deliberately not destructured: it describes the file,
  // not the match, and nothing downstream has any use for it.
  const match: MatchState = {
    id,
    ruleSet,
    seats: seats as Record<Side, StoredSeat>,
    history: [],
    board: createBoard(),
    turn: BLACK,
    status: 'playing',
    winner: null,
    winningStones: [],
    rejected: (rejected as Record<Side, StoredRefusal[]> | undefined) ?? { [BLACK]: [], [WHITE]: [] },
    /*
     * The last take-back, if there was one. Not derived: the moves it dropped
     * are gone from the list, so nothing that survives says they were ever
     * played. A player refused after one needs to know that happened, which
     * is why this is a stored event rather than a replayed view.
     */
    rewind: rewind ?? null,
    /*
     * A hold someone put on this game, if there is one. Also not derived: a
     * game waiting for a player who is coming back and one abandoned an hour
     * ago have the same move list, and only this tells them apart.
     */
    paused: paused ?? null,
    // A turn that was in flight when the server stopped restarts its clock.
    turnStartedAt: Date.now(),
    createdAt,
    updatedAt: updatedAt ?? createdAt,
    version: version ?? 0,
  }

  for (const move of history) {
    const color = move.color as Side
    const outcome = resolveMove(match.board, move.x, move.y, color, ruleSet)
    match.board[idx(move.x, move.y)] = color
    match.history.push(move)
    if (outcome.status === 'win') {
      match.status = 'win'
      match.winner = color
      match.winningStones = winningLine(match.board, move.x, move.y, color)
    } else if (outcome.status === 'draw') {
      match.status = 'draw'
    } else {
      match.turn = color === BLACK ? WHITE : BLACK
    }
  }
  return match
}

/**
 * Write a match, and say so in its type.
 *
 * The only place `Saved` is produced. A disk error is swallowed on purpose —
 * a match that cannot be written still plays, and losing the game to a full
 * disk would be the worse trade — so the brand claims the write was
 * attempted, not that the filesystem obliged.
 */
function persist(match: MatchState): Saved {
  try {
    mkdirSync(STORE, { recursive: true })
    writeFileSync(fileFor(match.id), JSON.stringify(toStored(match)))
  } catch {
    // A match that cannot be written still plays; it just will not survive a
    // restart. Losing the game to a disk error would be the worse trade.
  }
  return match as Saved
}

function forget(id: string): void {
  matches.delete(id)
  watchers.delete(id)
  try {
    rmSync(fileFor(id), { force: true })
  } catch {
    /* already gone */
  }
}

/**
 * Read whatever the last run left behind. Called once, at startup.
 *
 * Every file is checked against the stored schema and its format version
 * before it becomes a match. One file this server cannot read is one match
 * it will not show, not a broken store — and it is left where it is and said
 * out loud, because silently dropping someone's game is worse than refusing
 * to show it.
 */
function restore(): void {
  let files: string[] = []
  try {
    files = readdirSync(STORE).filter((name) => name.endsWith('.json'))
  } catch {
    return
  }
  for (const name of files) {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(join(STORE, name), 'utf8'))
    } catch {
      console.warn(`gomoku: skipped ${name} — not readable JSON. Left in place.`)
      continue
    }
    const read = readRecord(raw)
    if (!read.ok) {
      console.warn(`gomoku: skipped ${name} — ${read.reason}. Left in place.`)
      continue
    }
    const match = replay(read.record)
    // Read from disk, so it is already written: nothing to persist here.
    if (match.id) matches.set(match.id, match as Saved)
  }
}

/**
 * Every way this module can refuse.
 *
 * A union rather than a loose string, so the status map in `api.ts` can be
 * written `satisfies Record<MatchErrorCode, number>` — a code nobody mapped
 * is then a compile error instead of a silent 400.
 */
export type MatchErrorCode =
  | 'bad_json'
  | 'bad_point'
  | 'bad_rule_set'
  | 'bad_seat'
  | 'body_too_large'
  | 'illegal_move'
  | 'match_over'
  | 'match_paused'
  | 'no_such_match'
  | 'not_your_turn'
  | 'nothing_to_undo'

/** Whatever a refusal can say about itself beyond its message. */
export type MatchErrorDetail = Record<string, unknown>

export class MatchError extends Error {
  readonly code: MatchErrorCode
  detail: MatchErrorDetail

  constructor(code: MatchErrorCode, message: string, detail: MatchErrorDetail = {}) {
    super(message)
    this.code = code
    this.detail = detail
  }
}

/**
 * The state a refusal was judged against.
 *
 * A player that decided against one position and is refused against another
 * is not being told it misbehaved — it is being told the board moved. Without
 * `version` the two read identically, and the player has no reason to look
 * again before trying the same point.
 *
 * `rewound` is attached only while the take-back is still the most recent
 * thing that happened to the board: once a stone lands the move count moves
 * past it and this stops claiming it explains anything.
 */
export interface JudgedAgainst extends MatchErrorDetail {
  version: number
  moves: number
  rewound?: Omit<Rewind, 'movesAt'>
}

function judgedAgainst(match: MatchState): JudgedAgainst {
  const detail: JudgedAgainst = { version: match.version, moves: match.history.length }
  if (match.rewind && match.rewind.movesAt === match.history.length) {
    detail.rewound = {
      at: match.rewind.at,
      dropped: match.rewind.dropped,
      points: match.rewind.points,
    }
  }
  return detail
}

/** A caller may name a point either way; both end up here. */
export type PointArg = string | { x: number | string; y: number | string }

function parsePoint(value: PointArg): { x: number; y: number } {
  if (value && typeof value === 'object' && 'x' in value && 'y' in value) {
    return { x: Number(value.x), y: Number(value.y) }
  }
  const label = String(value ?? '')
    .trim()
    .toUpperCase()
  const match = /^([A-HJ-Z])(\d{1,2})$/.exec(label)
  if (!match) {
    throw new MatchError(
      'bad_point',
      `Not a point on this board: ${String(value)}. Use a label like H8, or {x, y}.`,
    )
  }
  const x = COLUMNS.indexOf(match[1] ?? '')
  const y = SIZE - Number(match[2])
  if (!inBounds(x, y)) {
    throw new MatchError('bad_point', `${label} is outside a ${SIZE}x${SIZE} board.`)
  }
  return { x, y }
}

/** The board as a grid an LLM can read without reconstructing it from a list. */
function asciiBoard(board: Board): string {
  const header = `   ${COLUMNS.slice(0, SIZE).split('').join(' ')}`
  const rows: string[] = []
  for (let y = 0; y < SIZE; y += 1) {
    const cells: string[] = []
    for (let x = 0; x < SIZE; x += 1) {
      const cell = board[idx(x, y)]
      cells.push(cell === BLACK ? 'X' : cell === WHITE ? 'O' : '.')
    }
    rows.push(`${String(SIZE - y).padStart(2, ' ')} ${cells.join(' ')}`)
  }
  return [header, ...rows, '', 'X = black, O = white, . = empty.'].join('\n')
}

function stonesOf(board: Board, color: Side): string[] {
  const out: string[] = []
  for (let i = 0; i < board.length; i += 1) {
    if (board[i] === color) out.push(coordLabel(i % SIZE, Math.floor(i / SIZE)))
  }
  return out
}

/**
 * Record a change: write it, wake whoever was waiting, tell every watcher.
 *
 * Returns `Saved`, so a mutation that skips it cannot be handed back.
 */
function notify(match: MatchState): Saved {
  match.updatedAt = new Date().toISOString()
  match.version += 1
  persist(match)

  for (const color of [BLACK, WHITE]) {
    const key = `${match.id}:${color}`
    const queue = waiters.get(key)
    if (!queue?.length) continue
    // Wake a seat when it is that seat's move, or when the game is no longer
    // running — which now includes being put on hold.
    if (statusOf(match) !== 'playing' || match.turn === color) {
      waiters.delete(key)
      for (const wake of queue) wake()
    }
  }

  for (const send of watchers.get(match.id) ?? []) {
    try {
      send(publicMatch(match))
    } catch {
      // A dead stream is dropped by its own close handler.
    }
  }

  // A match crosses from one class to the other when it ends or goes on hold,
  // so both caps are checked here rather than only when a board is opened.
  evictOldest(match.id)
  return match as Saved
}

const isFinished = (match: MatchState): boolean => match.status === 'win' || match.status === 'draw'

/**
 * What to lose first when a class is over its cap.
 *
 * An empty board nobody ever played is the cheapest thing in the store. A
 * game on hold outranks both, whether or not a stone has been played on it:
 * somebody said they were coming back to it, and that is the whole point of
 * the hold. Within a tier the least recently updated goes first.
 */
const evictionTier = (match: MatchState): number => {
  if (statusOf(match) === 'paused') return 2
  return match.history.length === 0 ? 0 : 1
}

function trim(
  candidates: Saved[],
  cap: number,
  keepId: string | null,
  rank: (match: MatchState) => number,
): void {
  let over = candidates.length - cap
  if (over <= 0) return
  const doomed = candidates
    .filter((match) => match.id !== keepId)
    .sort((a, b) => rank(a) - rank(b) || a.updatedAt.localeCompare(b.updatedAt))
  for (const match of doomed) {
    if (over <= 0) break
    forget(match.id)
    over -= 1
  }
}

/**
 * Keep the store bounded without deleting the games worth keeping.
 *
 * The two classes are capped separately. A burst of new boards can no longer
 * reach a finished record, which is the one someone opened New game expecting
 * to be able to go back to.
 *
 * `keepId` is the match that just changed. Without it a new board under a
 * tight cap could be the cheapest thing in the store and be deleted by the
 * very call that created it, leaving the caller holding an id for nothing.
 */
function evictOldest(keepId: string | null = null): void {
  const all = [...matches.values()]
  trim(
    all.filter((match) => !isFinished(match)),
    MAX_MATCHES,
    keepId,
    evictionTier,
  )
  trim(all.filter(isFinished), MAX_FINISHED, keepId, () => 0)
}

/** What a caller may say about a seat. Everything is optional and unverified. */
export interface SeatConfig {
  kind?: string | undefined
  label?: string | null | undefined
  assist?: string | undefined
}

function normalizeSeat(seat: SeatConfig = {}): StoredSeat {
  return {
    // `kind` is descriptive only; nothing here restricts who may call `play`.
    kind: seat.kind === 'agent' || seat.kind === 'engine' ? seat.kind : 'human',
    label: String(seat.label ?? '').slice(0, 60) || null,
    /**
     * `free` lets a player name any point on the board. `shortlist` also
     * returns a ranked set of candidates, which weaker models need in order
     * to produce a legal move at all.
     */
    assist: seat.assist === 'shortlist' ? 'shortlist' : 'free',
  }
}

/**
 * `| undefined` on each field rather than plain optional.
 *
 * Under `exactOptionalPropertyTypes` those are different things, and the
 * difference matters at this boundary: the values come out of an unchecked
 * JSON body, where "the caller said nothing" really does arrive as
 * `undefined` rather than as a missing key.
 */
export interface NewMatch {
  ruleSet?: string | undefined
  black?: SeatConfig | undefined
  white?: SeatConfig | undefined
}

export function createMatch({ ruleSet = 'free', black, white }: NewMatch = {}): Saved {
  if (!isRuleSet(ruleSet)) {
    throw new MatchError('bad_rule_set', `Unknown rule set: ${ruleSet}. Use "free" or "renju".`)
  }
  const match: MatchState = {
    id: randomUUID(),
    ruleSet,
    board: createBoard(),
    turn: BLACK,
    status: 'playing',
    winner: null,
    winningStones: [],
    history: [],
    seats: { [BLACK]: normalizeSeat(black), [WHITE]: normalizeSeat(white) },
    /** When the side to move was handed the turn, for thinking time. */
    turnStartedAt: Date.now(),
    /** Illegal attempts since the current side took the turn. */
    rejected: { [BLACK]: [], [WHITE]: [] },
    /** The last take-back, while it is still the most recent change. */
    rewind: null,
    /** A hold someone put on this game, or null. */
    paused: null,
    version: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  const saved = persist(match)
  matches.set(match.id, saved)
  evictOldest(match.id)
  return saved
}

/**
 * Look a match up, as something you may read or change.
 *
 * Deliberately `MatchState` and not `Saved`, even though the store only ever
 * holds written matches. Handing back `Saved` would let a caller mutate the
 * object and return it unchanged in the type system's eyes, which is the
 * whole mistake the brand exists to catch — verified by making a mutation
 * skip `notify` and watching it compile. Widening here is what turns that
 * into an error: the only way back to `Saved` is through `persist`.
 */
export function getMatch(id: string): MatchState {
  const match = matches.get(id)
  if (!match) throw new MatchError('no_such_match', `No match with id ${id}. It may have expired.`)
  return match
}

export interface MatchSummary {
  id: string
  ruleSet: RuleSetId
  status: PublicStatus
  turn: SeatName
  moves: number
  seats: Record<SeatName, StoredSeat>
  updatedAt: string
}

export function listMatches(): MatchSummary[] {
  return [...matches.values()]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((match) => ({
      id: match.id,
      ruleSet: match.ruleSet,
      status: statusOf(match),
      turn: seatName(match.turn),
      moves: match.history.length,
      seats: {
        black: match.seats[BLACK],
        white: match.seats[WHITE],
      },
      updatedAt: match.updatedAt,
    }))
}

/**
 * What a caller is allowed to see. Deliberately excludes any telemetry the
 * opposing engine produced: that is information about the opponent's
 * reasoning, and handing it over would stop the two sides being comparable.
 */
export interface ViewOptions {
  seat?: SeatName | null
  includeCandidates?: boolean | null
}

export function publicMatch(
  match: MatchState,
  { seat = null, includeCandidates = null }: ViewOptions = {},
): PublicMatch {
  const color = seat ? SEATS[seat] : null
  const wantCandidates = includeCandidates ?? (color ? match.seats[color].assist === 'shortlist' : false)

  const view: PublicMatch = {
    id: match.id,
    version: match.version,
    ruleSet: match.ruleSet,
    ruleSummary: RULE_SETS[match.ruleSet].blurb,
    status: statusOf(match),
    paused: match.paused,
    winner: match.winner ? seatName(match.winner) : null,
    winningStones: match.winningStones.map(([x, y]) => coordLabel(x, y)),
    turn: seatName(match.turn),
    yourTurn: color ? statusOf(match) === 'playing' && match.turn === color : null,
    seats: { black: match.seats[BLACK], white: match.seats[WHITE] },
    moves: match.history.length,
    board: {
      size: SIZE,
      ascii: asciiBoard(match.board),
      black: stonesOf(match.board, BLACK),
      white: stonesOf(match.board, WHITE),
      cells: Array.from(match.board),
    },
    history: match.history.map((move) => ({
      n: move.n,
      seat: seatName(move.color as Side),
      point: move.label,
      by: move.by,
      note: move.note,
      thinkingMs: move.thinkingMs,
      latencyMs: move.latencyMs,
      metrics: move.metrics,
      rejected: move.rejected,
    })),
    updatedAt: match.updatedAt,
  }

  /*
   * A board that was just rewound looks exactly like one that was never
   * played that far. Saying so is the only way a player who left a decision
   * against the old position can tell the difference on its next read.
   */
  if (match.rewind && match.rewind.movesAt === match.history.length) {
    view.rewound = {
      at: match.rewind.at,
      dropped: match.rewind.dropped,
      points: match.rewind.points,
    }
  }

  if (wantCandidates && statusOf(match) === 'playing') {
    const forColor = color ?? match.turn
    view.candidates = candidateMoves(match.board, forColor, match.ruleSet).map(
      (c: { label: string; rationale: string }) => ({
        point: c.label,
        rationale: c.rationale,
      }),
    )
  }
  return view
}

const median = (values: number[]): number | null => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2) return sorted[middle] ?? null
  return Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2)
}

/**
 * Work a player did accumulates over a match; a confidence or a probability
 * does not. Adding the second kind produces a number like 9.25 that means
 * nothing, so those are averaged and the key says so.
 */
const ADDITIVE = /(_tokens|^nodes$|^cutoffs$|^playouts$|^simulations$|^calls$|_ms$|^cost)/

/**
 * A side's account of its own work.
 *
 * Two kinds of number live in one bag, and telling them apart is the point:
 * `sums` are counts that accumulate over a match, `mean …` are figures that
 * do not. Adding the second kind is what once produced a total confidence of
 * 9.25, so the key says which it is.
 */
export interface MetricTotals {
  sources: ('measured' | 'reported')[]
  [figure: string]: number | ('measured' | 'reported')[]
}

function totalMetrics(moves: StoredMove[]): MetricTotals | null {
  const sums: Record<string, number> = {}
  const samples: Record<string, number[]> = {}
  const sources = new Set<'measured' | 'reported'>()

  for (const move of moves) {
    if (!move.metrics) continue
    sources.add(move.metrics.source)
    for (const [key, value] of Object.entries(move.metrics)) {
      if (key === 'source' || typeof value !== 'number') continue
      if (ADDITIVE.test(key)) sums[key] = (sums[key] ?? 0) + value
      else (samples[key] ??= []).push(value)
    }
  }

  const averaged: Record<string, number> = {}
  for (const [key, values] of Object.entries(samples)) {
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length
    // Two decimals: these are ratios and scores, not counts.
    averaged[`mean ${key}`] = Math.round(mean * 100) / 100
  }

  // A side whose account is all text still told us something: keep the
  // sources so the summary can say so rather than reading as silence.
  if (sources.size === 0) return null
  return { sources: [...sources], ...sums, ...averaged }
}

/**
 * Everything needed to go back through a finished match: each move with who
 * played it, how long they took, what they said about it, and what they tried
 * that the board refused — plus a per-side summary.
 *
 * Thinking time is measured here and is the only figure comparable across
 * every kind of player. Everything under `metrics` is whatever that player
 * could produce, and carries the source that produced it.
 */
export interface ReviewSide {
  seat: SeatName
  player: StoredSeat
  moves: number
  rejected: number
  thinking: {
    totalMs: number
    medianMs: number | null
    slowestMs: number | null
    fastestMs: number | null
  }
  metrics: MetricTotals | null
}

export interface ReviewMove extends Omit<PublicMove, 'latencyMs'> {
  at: string
}

export interface Review {
  id: string
  ruleSet: RuleSetId
  status: PublicStatus
  winner: SeatName | null
  winningStones: string[]
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
  sides: Record<SeatName, ReviewSide>
  moves: ReviewMove[]
  positions: number[][]
  note: string
}

export function reviewMatch(matchId: string): Review {
  const match = getMatch(matchId)

  const side = (color: Side): ReviewSide => {
    const moves = match.history.filter((move) => move.color === color)
    const times = moves.map((move) => move.thinkingMs).filter((ms) => typeof ms === 'number')
    return {
      seat: seatName(color),
      player: match.seats[color],
      moves: moves.length,
      rejected: moves.reduce((sum, move) => sum + (move.rejected?.length ?? 0), 0),
      thinking: {
        totalMs: times.reduce((sum, ms) => sum + ms, 0),
        medianMs: median(times),
        slowestMs: times.length ? Math.max(...times) : null,
        fastestMs: times.length ? Math.min(...times) : null,
      },
      metrics: totalMetrics(moves),
    }
  }

  const finishedAt = match.history.at(-1)?.at ?? null
  const review: Review = {
    id: match.id,
    ruleSet: match.ruleSet,
    status: statusOf(match),
    winner: match.winner ? seatName(match.winner) : null,
    winningStones: match.winningStones.map(([x, y]) => coordLabel(x, y)),
    startedAt: match.createdAt,
    finishedAt,
    durationMs: finishedAt ? Date.parse(finishedAt) - Date.parse(match.createdAt) : null,
    sides: { black: side(BLACK), white: side(WHITE) },
    moves: match.history.map((move) => ({
      n: move.n,
      seat: seatName(move.color as Side),
      point: move.label,
      by: move.by,
      note: move.note,
      thinkingMs: move.thinkingMs,
      metrics: move.metrics,
      rejected: move.rejected,
      at: move.at,
    })),
    /**
     * One frame per move, replayed from the same move list the store holds.
     * Nothing here is remembered; it is all the history seen step by step.
     */
    positions: match.history
      .reduce(
        (frames, move) => {
          // The seed frame is always there, so `at(-1)` cannot miss; saying
          // so costs one fallback and buys the honest type.
          const next = (frames.at(-1) ?? []).slice()
          next[idx(move.x, move.y)] = move.color
          frames.push(next)
          return frames
        },
        [Array.from(createBoard())],
      )
      .map((frame) => Array.from(frame)),
    note:
      'thinkingMs is measured by the server and comparable across players. ' +
      'Everything under metrics is whatever that player could produce; check its source before comparing. ' +
      'A seat label is free text supplied by whoever opened the match and is not verified — a player claiming to be a given model is a claim, not a finding.',
  }
  return review
}

/** What the caller can say about a move it is making. */
export interface PlayDetails {
  by?: string | null
  latencyMs?: number | null
  note?: string | null
  metrics?: Record<string, unknown> | null
}

/**
 * Note what a player tried and could not have.
 *
 * A refusal changes no stone, so it never reaches `notify` — which is exactly
 * how a record was lost before a test caught it. One function, and it writes.
 * The return type is `never`, so a caller cannot leave the throw off.
 */
function refuse(match: MatchState, error: MatchError): never {
  persist(match)
  throw error
}

/** Place a stone. Throws MatchError with a reason instead of taking the turn. */
export function play(
  matchId: string,
  seat: string,
  point: PointArg,
  { by = null, latencyMs = null, note = null, metrics = null }: PlayDetails = {},
): Saved {
  const match = getMatch(matchId)
  const color = SEATS[seat as SeatName]
  if (!color) throw new MatchError('bad_seat', `Unknown seat: ${seat}. Use "black" or "white".`)
  if (statusOf(match) === 'paused') {
    throw new MatchError(
      'match_paused',
      `This match is on hold${match.paused?.by ? `, put there by ${match.paused.by}` : ''}` +
        `${match.paused?.note ? `: ${match.paused.note}` : ''}. Resume it before playing.`,
      { paused: match.paused, ...judgedAgainst(match) },
    )
  }
  if (match.status !== 'playing') {
    throw new MatchError('match_over', `This match is already finished: ${match.status}.`, {
      status: match.status,
      winner: match.winner ? seatName(match.winner) : null,
      ...judgedAgainst(match),
    })
  }
  if (match.turn !== color) {
    const state = judgedAgainst(match)
    const message = state.rewound
      ? `The board was taken back ${state.rewound.dropped === 1 ? 'one move' : `${state.rewound.dropped} moves`} ` +
        `(${state.rewound.points.join(', ')} removed), and it is ${seatName(match.turn)}'s move now, not ${seat}'s. ` +
        'Read the board again before choosing: the position you decided against is gone.'
      : `It is ${seatName(match.turn)}'s move, not ${seat}'s.`
    throw new MatchError('not_your_turn', message, { turn: seatName(match.turn), ...state })
  }

  let x: number
  let y: number
  try {
    ;({ x, y } = parsePoint(point))
  } catch (error) {
    // A point that does not parse is still something the player tried.
    match.rejected[color].push({ point: String(point), reason: 'bad-point', at: new Date().toISOString() })
    if (error instanceof MatchError) {
      error.detail = { ...error.detail, ...judgedAgainst(match) }
      refuse(match, error)
    }
    persist(match)
    throw error
  }

  const legality = moveLegality(match.board, x, y, color, match.ruleSet)
  if (!legality.legal) {
    // Only the renju shapes have copy; `occupied` and `off-board` do not,
    // and the message below already has a sentence for each of them.
    const copy =
      legality.reason in FORBIDDEN_COPY
        ? FORBIDDEN_COPY[legality.reason as keyof typeof FORBIDDEN_COPY]
        : null
    const message =
      legality.reason === 'occupied'
        ? `${coordLabel(x, y)} already has a stone on it.`
        : copy
          ? `${coordLabel(x, y)} is forbidden under renju: ${copy.label.toLowerCase()}. ${copy.detail}`
          : `${coordLabel(x, y)} is not a legal move (${legality.reason}).`
    // The turn is untouched: name another point. What was tried is kept, so a
    // review can show what a player considered and why it was refused.
    match.rejected[color].push({
      point: coordLabel(x, y),
      reason: legality.reason,
      at: new Date().toISOString(),
    })
    refuse(
      match,
      new MatchError('illegal_move', message, {
        reason: legality.reason,
        point: coordLabel(x, y),
        ...judgedAgainst(match),
      }),
    )
  }

  const outcome = resolveMove(match.board, x, y, color, match.ruleSet)
  match.board[idx(x, y)] = color
  match.history.push({
    n: match.history.length + 1,
    x,
    y,
    color,
    label: coordLabel(x, y),
    by: by ?? match.seats[color].label ?? match.seats[color].kind,
    note,
    /*
     * Measured here rather than taken from the caller, so both sides are on
     * the same clock. It spans the whole wait — the player's own reasoning
     * plus the round trip — which is what "how long did it take to move"
     * means to someone watching the board.
     */
    thinkingMs: Math.max(0, Date.now() - match.turnStartedAt),
    /** What the caller measured on its own side, when it measured anything. */
    latencyMs,
    metrics: normalizeMetrics(metrics),
    rejected: match.rejected[color],
    at: new Date().toISOString(),
  })
  match.rejected[color] = []

  if (outcome.status === 'win') {
    match.status = 'win'
    match.winner = color
    match.winningStones = winningLine(match.board, x, y, color)
  } else if (outcome.status === 'draw') {
    match.status = 'draw'
  } else {
    match.turn = color === BLACK ? WHITE : BLACK
    match.turnStartedAt = Date.now()
  }

  return notify(match)
}

/**
 * Keep whatever a player could tell us, tagged with how much it is worth.
 * A search engine counts its own nodes; a model's endpoint returns real token
 * counts; an agent can only report its own usage, which nothing here can
 * check. Recording the difference is the point.
 */
function normalizeMetrics(metrics: Record<string, unknown> | null): StoredMetrics {
  if (!metrics || typeof metrics !== 'object') return null
  const { source, ...rest } = metrics
  const kept: Record<string, number | string | boolean> = {}
  for (const [key, value] of Object.entries(rest)) {
    if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
      kept[key] = value
    }
  }
  if (Object.keys(kept).length === 0) return null
  const claimed = typeof source === 'string' && METRIC_SOURCES.has(source) ? source : 'reported'
  return { source: claimed as 'measured' | 'reported', ...kept }
}

/**
 * Take back the last move, or the last two when the most recent was not the
 * caller's own. Rebuilds the board from the surviving history rather than
 * trying to reverse a move in place.
 */
export function undoMove(matchId: string, { count = 1 }: { count?: number } = {}): Saved {
  const match = getMatch(matchId)
  if (match.history.length === 0) {
    throw new MatchError('nothing_to_undo', 'No moves have been played yet.')
  }
  const drop = Math.min(Math.max(Math.trunc(count) || 1, 1), match.history.length)
  const remaining = match.history.slice(0, -drop)
  const dropped = match.history.slice(-drop)

  match.board = createBoard()
  for (const move of remaining) match.board[idx(move.x, move.y)] = move.color
  match.history = remaining.map((move, i) => ({ ...move, n: i + 1 }))
  match.status = 'playing'
  match.winner = null
  match.winningStones = []
  match.turn = remaining.length % 2 === 0 ? BLACK : WHITE
  match.turnStartedAt = Date.now()
  match.rejected = { [BLACK]: [], [WHITE]: [] }
  /*
   * Take back is a single-screen control, but a match can have a player who
   * is not on that screen and is already deciding against the position this
   * just removed. That player finds out by being refused, so the refusal has
   * to be able to say what actually happened. `movesAt` is what keeps the
   * claim honest: it holds only until the next stone lands.
   */
  match.rewind = {
    at: new Date().toISOString(),
    dropped: drop,
    points: dropped.map((move) => move.label),
    movesAt: remaining.length,
  }
  return notify(match)
}

export function resetMatch(matchId: string): Saved {
  const match = getMatch(matchId)
  match.board = createBoard()
  match.turn = BLACK
  match.status = 'playing'
  match.winner = null
  match.winningStones = []
  match.history = []
  match.turnStartedAt = Date.now()
  match.rejected = { [BLACK]: [], [WHITE]: [] }
  // An empty board is not a rewound one, and both have no moves: without
  // clearing this a reset would inherit the last take-back's explanation.
  match.rewind = null
  return notify(match)
}

export interface MatchUpdate {
  ruleSet?: string | undefined
  black?: SeatConfig | undefined
  white?: SeatConfig | undefined
}

export function updateMatch(matchId: string, { ruleSet, black, white }: MatchUpdate = {}): Saved {
  const match = getMatch(matchId)
  if (ruleSet !== undefined) {
    if (!isRuleSet(ruleSet)) throw new MatchError('bad_rule_set', `Unknown rule set: ${ruleSet}.`)
    match.ruleSet = ruleSet
  }
  if (black) match.seats[BLACK] = normalizeSeat({ ...match.seats[BLACK], ...black })
  if (white) match.seats[WHITE] = normalizeSeat({ ...match.seats[WHITE], ...white })
  return notify(match)
}

/**
 * Put a match on hold, or take it off hold.
 *
 * Surviving a restart is not the same as resuming one. A game waiting for a
 * player who is coming back and a game abandoned an hour ago have the same
 * move list and, until this existed, the same status — so anyone looking at
 * either saw a live match that was not moving. A hold says which it is.
 */
export interface HoldRequest {
  paused?: boolean
  by?: string | null
  note?: string | null
}

export function pauseMatch(
  matchId: string,
  { paused = true, by = null, note = null }: HoldRequest = {},
): Saved {
  const match = getMatch(matchId)
  if (match.status !== 'playing') {
    throw new MatchError('match_over', `This match is already finished: ${match.status}.`, {
      status: match.status,
      ...judgedAgainst(match),
    })
  }
  match.paused = paused
    ? {
        at: new Date().toISOString(),
        by: by ? String(by).slice(0, 60) : null,
        note: note ? String(note).slice(0, 200) : null,
      }
    : null
  return notify(match)
}

/**
 * Resolve once it is this seat's move, or the match stops running, or the
 * wait times out. MCP servers cannot call their clients, so an agent waiting
 * for its opponent holds one call open here instead of polling.
 */
export interface WaitResult {
  timedOut: boolean
  /** Why the wait ended when it was not the turn arriving, or null. */
  interrupted: string | null
}

export function awaitTurn(matchId: string, seat: string, timeoutMs = 120_000): Promise<WaitResult> {
  const match = getMatch(matchId)
  const color = SEATS[seat as SeatName]
  if (!color) throw new MatchError('bad_seat', `Unknown seat: ${seat}.`)
  if (statusOf(match) !== 'playing' || match.turn === color) {
    return Promise.resolve({ timedOut: false, interrupted: null })
  }

  const key = `${matchId}:${color}`
  return new Promise<WaitResult>((resolve) => {
    const queue = waiters.get(key) ?? []
    let timer: ReturnType<typeof setTimeout> | null = null
    const done = (timedOut: boolean, interrupted: string | null = null): void => {
      if (timer) clearTimeout(timer)
      const remaining = waiters.get(key)
      if (remaining) {
        const at = remaining.indexOf(wake)
        if (at !== -1) remaining.splice(at, 1)
      }
      resolve({ timedOut, interrupted })
    }
    const wake: Wake = (interrupted = null) => done(false, interrupted ?? null)
    queue.push(wake)
    waiters.set(key, queue)
    timer = setTimeout(() => done(true), Math.min(Math.max(timeoutMs, 1000), 600_000))
  })
}

/**
 * Answer every held call before the process goes away.
 *
 * A held `await_turn` or `play(wait_ms)` is an open HTTP request. When the
 * server stops under it the request fails at the transport, and the caller
 * gets an error that is neither "slow opponent" nor "match gone" — the only
 * two cases its instructions cover. Released here it gets an ordinary answer
 * that says why the wait ended and that the match is still there.
 *
 * This covers a stop the process is told about. A crash or a killed socket
 * still drops the call, which is why a dropped held call means ask again.
 */
export function releaseWaiters(reason = 'server_stopping'): number {
  const held = [...waiters.entries()]
  waiters.clear()
  for (const [, queue] of held) {
    for (const wake of queue) wake(reason)
  }
  return held.reduce((count, [, queue]) => count + queue.length, 0)
}

/** Subscribe to a match. Returns an unsubscribe function. */
export function watchMatch(matchId: string, send: Send): () => void {
  const match = getMatch(matchId)
  const list = watchers.get(matchId) ?? []
  list.push(send)
  watchers.set(matchId, list)
  send(publicMatch(match))
  return () => {
    const current = watchers.get(matchId)
    if (!current) return
    const at = current.indexOf(send)
    if (at !== -1) current.splice(at, 1)
  }
}

export { SIZE, BLACK, WHITE, EMPTY }

// Pick up anything the previous run left behind.
restore()

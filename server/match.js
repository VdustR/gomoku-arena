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
} from '../src/lib/rules.js'
import { candidateMoves } from '../src/lib/ai/heuristic.js'
import { FORMAT_VERSION, readRecord } from './record.js'

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
const MAX_MATCHES = Number(process.env.GOMOKU_MAX_MATCHES ?? 50) || 50
const MAX_FINISHED = Number(process.env.GOMOKU_MAX_FINISHED ?? 200) || 200

/**
 * What a player could tell us about a move varies by what the player is, so
 * the record keeps whatever each one can actually produce rather than forcing
 * one shape. `source` says where a number came from, because a search engine
 * counting its own nodes and an agent reporting its own token use are not
 * evidence of the same quality.
 */
const METRIC_SOURCES = new Set(['measured', 'reported'])

/** Seat names as everyone outside this module spells them. */
export const SEATS = { black: BLACK, white: WHITE }
export const seatName = (color) => (color === BLACK ? 'black' : 'white')

/**
 * The status anyone outside this module sees.
 *
 * `match.status` is replayed from the moves and only ever says how the game
 * stands. A hold is not in the moves, so it is stored separately and folded
 * in here: a game waiting for a player who is coming back reads as held
 * rather than as one nobody has touched for an hour.
 */
export const statusOf = (match) =>
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
const STORE = process.env.GOMOKU_STATE_DIR
  ? resolve(process.env.GOMOKU_STATE_DIR)
  : resolve(fileURLToPath(new URL('../.matches', import.meta.url)))

const matches = new Map()
/** Resolvers waiting for a seat's turn, keyed by `${matchId}:${color}`. */
const waiters = new Map()
/** Subscribers to any change in a match, for the browser's event stream. */
const watchers = new Map()

const fileFor = (id) => join(STORE, `${id}.json`)

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
const toStored = (match) => ({
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
export function replay({ id, ruleSet, seats, history, rejected, rewind, paused, createdAt, updatedAt, version }) {
  // `formatVersion` is deliberately not destructured: it describes the file,
  // not the match, and nothing downstream has any use for it.
  const match = {
    id,
    ruleSet,
    seats,
    history: [],
    board: createBoard(),
    turn: BLACK,
    status: 'playing',
    winner: null,
    winningStones: [],
    rejected: rejected ?? { [BLACK]: [], [WHITE]: [] },
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
    const outcome = resolveMove(match.board, move.x, move.y, move.color, ruleSet)
    match.board[idx(move.x, move.y)] = move.color
    match.history.push(move)
    if (outcome.status === 'win') {
      match.status = 'win'
      match.winner = move.color
      match.winningStones = winningLine(match.board, move.x, move.y, move.color)
    } else if (outcome.status === 'draw') {
      match.status = 'draw'
    } else {
      match.turn = move.color === BLACK ? WHITE : BLACK
    }
  }
  return match
}


function persist(match) {
  try {
    mkdirSync(STORE, { recursive: true })
    writeFileSync(fileFor(match.id), JSON.stringify(toStored(match)))
  } catch {
    // A match that cannot be written still plays; it just will not survive a
    // restart. Losing the game to a disk error would be the worse trade.
  }
}

function forget(id) {
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
function restore() {
  let files = []
  try {
    files = readdirSync(STORE).filter((name) => name.endsWith('.json'))
  } catch {
    return
  }
  for (const name of files) {
    let raw
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
    if (match?.id) matches.set(match.id, match)
  }
}

export class MatchError extends Error {
  constructor(code, message, detail = {}) {
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
function judgedAgainst(match) {
  const detail = { version: match.version, moves: match.history.length }
  if (match.rewind && match.rewind.movesAt === match.history.length) {
    detail.rewound = {
      at: match.rewind.at,
      dropped: match.rewind.dropped,
      points: match.rewind.points,
    }
  }
  return detail
}

function parsePoint(value) {
  if (value && typeof value === 'object' && 'x' in value && 'y' in value) {
    return { x: Number(value.x), y: Number(value.y) }
  }
  const label = String(value ?? '').trim().toUpperCase()
  const match = /^([A-HJ-Z])(\d{1,2})$/.exec(label)
  if (!match) {
    throw new MatchError('bad_point', `Not a point on this board: ${value}. Use a label like H8, or {x, y}.`)
  }
  const x = COLUMNS.indexOf(match[1])
  const y = SIZE - Number(match[2])
  if (!inBounds(x, y)) {
    throw new MatchError('bad_point', `${label} is outside a ${SIZE}x${SIZE} board.`)
  }
  return { x, y }
}

/** The board as a grid an LLM can read without reconstructing it from a list. */
function asciiBoard(board) {
  const header = `   ${COLUMNS.slice(0, SIZE).split('').join(' ')}`
  const rows = []
  for (let y = 0; y < SIZE; y += 1) {
    const cells = []
    for (let x = 0; x < SIZE; x += 1) {
      const cell = board[idx(x, y)]
      cells.push(cell === BLACK ? 'X' : cell === WHITE ? 'O' : '.')
    }
    rows.push(`${String(SIZE - y).padStart(2, ' ')} ${cells.join(' ')}`)
  }
  return [header, ...rows, '', 'X = black, O = white, . = empty.'].join('\n')
}

function stonesOf(board, color) {
  const out = []
  for (let i = 0; i < board.length; i += 1) {
    if (board[i] === color) out.push(coordLabel(i % SIZE, Math.floor(i / SIZE)))
  }
  return out
}

function notify(match) {
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
}

const isFinished = (match) => match.status === 'win' || match.status === 'draw'

/**
 * What to lose first when a class is over its cap.
 *
 * An empty board nobody ever played is the cheapest thing in the store. A
 * game on hold outranks both, whether or not a stone has been played on it:
 * somebody said they were coming back to it, and that is the whole point of
 * the hold. Within a tier the least recently updated goes first.
 */
const evictionTier = (match) => {
  if (statusOf(match) === 'paused') return 2
  return match.history.length === 0 ? 0 : 1
}

function trim(candidates, cap, keepId, rank) {
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
function evictOldest(keepId = null) {
  const all = [...matches.values()]
  trim(all.filter((match) => !isFinished(match)), MAX_MATCHES, keepId, evictionTier)
  trim(all.filter(isFinished), MAX_FINISHED, keepId, () => 0)
}

function normalizeSeat(seat = {}) {
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

export function createMatch({ ruleSet = 'free', black, white } = {}) {
  if (!RULE_SETS[ruleSet]) {
    throw new MatchError('bad_rule_set', `Unknown rule set: ${ruleSet}. Use "free" or "renju".`)
  }
  const match = {
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
  matches.set(match.id, match)
  persist(match)
  evictOldest(match.id)
  return match
}

export function getMatch(id) {
  const match = matches.get(id)
  if (!match) throw new MatchError('no_such_match', `No match with id ${id}. It may have expired.`)
  return match
}

export function listMatches() {
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
export function publicMatch(match, { seat = null, includeCandidates = null } = {}) {
  const color = seat ? SEATS[seat] : null
  const wantCandidates =
    includeCandidates ?? (color ? match.seats[color].assist === 'shortlist' : false)

  const view = {
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
      seat: seatName(move.color),
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
    view.candidates = candidateMoves(match.board, forColor, match.ruleSet).map((c) => ({
      point: c.label,
      rationale: c.rationale,
    }))
  }
  return view
}

const median = (values) => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2)
}

/**
 * Work a player did accumulates over a match; a confidence or a probability
 * does not. Adding the second kind produces a number like 9.25 that means
 * nothing, so those are averaged and the key says so.
 */
const ADDITIVE = /(_tokens|^nodes$|^cutoffs$|^playouts$|^simulations$|^calls$|_ms$|^cost)/

function totalMetrics(moves) {
  const sums = {}
  const samples = {}
  const sources = new Set()

  for (const move of moves) {
    if (!move.metrics) continue
    sources.add(move.metrics.source)
    for (const [key, value] of Object.entries(move.metrics)) {
      if (key === 'source' || typeof value !== 'number') continue
      if (ADDITIVE.test(key)) sums[key] = (sums[key] ?? 0) + value
      else (samples[key] ??= []).push(value)
    }
  }

  const averaged = {}
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
export function reviewMatch(matchId) {
  const match = getMatch(matchId)

  const side = (color) => {
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
  return {
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
      seat: seatName(move.color),
      point: move.label,
      by: move.by,
      note: move.note,
      thinkingMs: move.thinkingMs,
      metrics: move.metrics,
      rejected: move.rejected ?? [],
      at: move.at,
    })),
    /**
     * One frame per move, replayed from the same move list the store holds.
     * Nothing here is remembered; it is all the history seen step by step.
     */
    positions: match.history
      .reduce(
        (frames, move) => {
          const next = frames.at(-1).slice()
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
}

/** Place a stone. Throws MatchError with a reason instead of taking the turn. */
export function play(matchId, seat, point, { by = null, latencyMs = null, note = null, metrics = null } = {}) {
  const match = getMatch(matchId)
  const color = SEATS[seat]
  if (!color) throw new MatchError('bad_seat', `Unknown seat: ${seat}. Use "black" or "white".`)
  if (statusOf(match) === 'paused') {
    throw new MatchError(
      'match_paused',
      `This match is on hold${match.paused.by ? `, put there by ${match.paused.by}` : ''}` +
        `${match.paused.note ? `: ${match.paused.note}` : ''}. Resume it before playing.`,
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

  let x
  let y
  try {
    ;({ x, y } = parsePoint(point))
  } catch (error) {
    // A point that does not parse is still something the player tried.
    match.rejected[color].push({ point: String(point), reason: 'bad-point', at: new Date().toISOString() })
    persist(match)
    error.detail = { ...error.detail, ...judgedAgainst(match) }
    throw error
  }

  const legality = moveLegality(match.board, x, y, color, match.ruleSet)
  if (!legality.legal) {
    const copy = FORBIDDEN_COPY[legality.reason]
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
    // A refusal changes no stone, so notify does not run: save it explicitly
    // or the attempt disappears with the next restart.
    persist(match)
    throw new MatchError('illegal_move', message, {
      reason: legality.reason,
      point: coordLabel(x, y),
      ...judgedAgainst(match),
    })
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

  notify(match)
  return match
}

/**
 * Keep whatever a player could tell us, tagged with how much it is worth.
 * A search engine counts its own nodes; a model's endpoint returns real token
 * counts; an agent can only report its own usage, which nothing here can
 * check. Recording the difference is the point.
 */
function normalizeMetrics(metrics) {
  if (!metrics || typeof metrics !== 'object') return null
  const { source, ...rest } = metrics
  const kept = {}
  for (const [key, value] of Object.entries(rest)) {
    if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
      kept[key] = value
    }
  }
  if (Object.keys(kept).length === 0) return null
  return { source: METRIC_SOURCES.has(source) ? source : 'reported', ...kept }
}

/**
 * Take back the last move, or the last two when the most recent was not the
 * caller's own. Rebuilds the board from the surviving history rather than
 * trying to reverse a move in place.
 */
export function undoMove(matchId, { count = 1 } = {}) {
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
  notify(match)
  return match
}

export function resetMatch(matchId) {
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
  notify(match)
  return match
}

export function updateMatch(matchId, { ruleSet, black, white } = {}) {
  const match = getMatch(matchId)
  if (ruleSet !== undefined) {
    if (!RULE_SETS[ruleSet]) throw new MatchError('bad_rule_set', `Unknown rule set: ${ruleSet}.`)
    match.ruleSet = ruleSet
  }
  if (black) match.seats[BLACK] = normalizeSeat({ ...match.seats[BLACK], ...black })
  if (white) match.seats[WHITE] = normalizeSeat({ ...match.seats[WHITE], ...white })
  notify(match)
  return match
}

/**
 * Put a match on hold, or take it off hold.
 *
 * Surviving a restart is not the same as resuming one. A game waiting for a
 * player who is coming back and a game abandoned an hour ago have the same
 * move list and, until this existed, the same status — so anyone looking at
 * either saw a live match that was not moving. A hold says which it is.
 */
export function pauseMatch(matchId, { paused = true, by = null, note = null } = {}) {
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
  notify(match)
  return match
}

/**
 * Resolve once it is this seat's move, or the match stops running, or the
 * wait times out. MCP servers cannot call their clients, so an agent waiting
 * for its opponent holds one call open here instead of polling.
 */
export function awaitTurn(matchId, seat, timeoutMs = 120_000) {
  const match = getMatch(matchId)
  const color = SEATS[seat]
  if (!color) throw new MatchError('bad_seat', `Unknown seat: ${seat}.`)
  if (statusOf(match) !== 'playing' || match.turn === color) {
    return Promise.resolve({ timedOut: false, interrupted: null })
  }

  const key = `${matchId}:${color}`
  return new Promise((resolve) => {
    const queue = waiters.get(key) ?? []
    let timer = null
    const done = (timedOut, interrupted = null) => {
      if (timer) clearTimeout(timer)
      const remaining = waiters.get(key)
      if (remaining) {
        const at = remaining.indexOf(wake)
        if (at !== -1) remaining.splice(at, 1)
      }
      resolve({ timedOut, interrupted })
    }
    const wake = (interrupted = null) => done(false, interrupted)
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
export function releaseWaiters(reason = 'server_stopping') {
  const held = [...waiters.entries()]
  waiters.clear()
  for (const [, queue] of held) {
    for (const wake of queue) wake(reason)
  }
  return held.reduce((count, [, queue]) => count + queue.length, 0)
}

/** Subscribe to a match. Returns an unsubscribe function. */
export function watchMatch(matchId, send) {
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

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

const COLUMNS = 'ABCDEFGHJKLMNOPQRSTUVWXYZ'
const MAX_MATCHES = Number(process.env.GOMOKU_MAX_MATCHES ?? 50) || 50

/** Seat names as everyone outside this module spells them. */
export const SEATS = { black: BLACK, white: WHITE }
export const seatName = (color) => (color === BLACK ? 'black' : 'white')

const matches = new Map()
/** Resolvers waiting for a seat's turn, keyed by `${matchId}:${color}`. */
const waiters = new Map()
/** Subscribers to any change in a match, for the browser's event stream. */
const watchers = new Map()

export class MatchError extends Error {
  constructor(code, message, detail = {}) {
    super(message)
    this.code = code
    this.detail = detail
  }
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

  for (const color of [BLACK, WHITE]) {
    const key = `${match.id}:${color}`
    const queue = waiters.get(key)
    if (!queue?.length) continue
    // Wake a seat when it is that seat's move, or when the game has ended.
    if (match.status !== 'playing' || match.turn === color) {
      waiters.delete(key)
      for (const resolve of queue) resolve()
    }
  }

  for (const send of watchers.get(match.id) ?? []) {
    try {
      send(publicMatch(match))
    } catch {
      // A dead stream is dropped by its own close handler.
    }
  }
}

function evictOldest() {
  while (matches.size > MAX_MATCHES) {
    let oldest = null
    for (const match of matches.values()) {
      if (!oldest || match.updatedAt < oldest.updatedAt) oldest = match
    }
    if (!oldest) break
    matches.delete(oldest.id)
    watchers.delete(oldest.id)
  }
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
    version: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  matches.set(match.id, match)
  evictOldest()
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
      status: match.status,
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
    status: match.status,
    winner: match.winner ? seatName(match.winner) : null,
    winningStones: match.winningStones.map(([x, y]) => coordLabel(x, y)),
    turn: seatName(match.turn),
    yourTurn: color ? match.status === 'playing' && match.turn === color : null,
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
      latencyMs: move.latencyMs,
    })),
    updatedAt: match.updatedAt,
  }

  if (wantCandidates && match.status === 'playing') {
    const forColor = color ?? match.turn
    view.candidates = candidateMoves(match.board, forColor, match.ruleSet).map((c) => ({
      point: c.label,
      rationale: c.rationale,
    }))
  }
  return view
}

/** Place a stone. Throws MatchError with a reason instead of taking the turn. */
export function play(matchId, seat, point, { by = null, latencyMs = null } = {}) {
  const match = getMatch(matchId)
  const color = SEATS[seat]
  if (!color) throw new MatchError('bad_seat', `Unknown seat: ${seat}. Use "black" or "white".`)
  if (match.status !== 'playing') {
    throw new MatchError('match_over', `This match is already finished: ${match.status}.`, {
      status: match.status,
      winner: match.winner ? seatName(match.winner) : null,
    })
  }
  if (match.turn !== color) {
    throw new MatchError('not_your_turn', `It is ${seatName(match.turn)}'s move, not ${seat}'s.`, {
      turn: seatName(match.turn),
    })
  }

  const { x, y } = parsePoint(point)
  const legality = moveLegality(match.board, x, y, color, match.ruleSet)
  if (!legality.legal) {
    const copy = FORBIDDEN_COPY[legality.reason]
    const message =
      legality.reason === 'occupied'
        ? `${coordLabel(x, y)} already has a stone on it.`
        : copy
          ? `${coordLabel(x, y)} is forbidden under renju: ${copy.label.toLowerCase()}. ${copy.detail}`
          : `${coordLabel(x, y)} is not a legal move (${legality.reason}).`
    // The turn is untouched: name another point.
    throw new MatchError('illegal_move', message, { reason: legality.reason, point: coordLabel(x, y) })
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
    latencyMs,
    at: new Date().toISOString(),
  })

  if (outcome.status === 'win') {
    match.status = 'win'
    match.winner = color
    match.winningStones = winningLine(match.board, x, y, color)
  } else if (outcome.status === 'draw') {
    match.status = 'draw'
  } else {
    match.turn = color === BLACK ? WHITE : BLACK
  }

  notify(match)
  return match
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

  match.board = createBoard()
  for (const move of remaining) match.board[idx(move.x, move.y)] = move.color
  match.history = remaining.map((move, i) => ({ ...move, n: i + 1 }))
  match.status = 'playing'
  match.winner = null
  match.winningStones = []
  match.turn = remaining.length % 2 === 0 ? BLACK : WHITE
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
 * Resolve once it is this seat's move, or the match ends, or the wait times
 * out. MCP servers cannot call their clients, so an agent waiting for its
 * opponent holds one call open here instead of polling.
 */
export function awaitTurn(matchId, seat, timeoutMs = 120_000) {
  const match = getMatch(matchId)
  const color = SEATS[seat]
  if (!color) throw new MatchError('bad_seat', `Unknown seat: ${seat}.`)
  if (match.status !== 'playing' || match.turn === color) {
    return Promise.resolve({ timedOut: false })
  }

  const key = `${matchId}:${color}`
  return new Promise((resolve) => {
    const queue = waiters.get(key) ?? []
    let timer = null
    const done = (timedOut) => {
      if (timer) clearTimeout(timer)
      const remaining = waiters.get(key)
      if (remaining) {
        const at = remaining.indexOf(wake)
        if (at !== -1) remaining.splice(at, 1)
      }
      resolve({ timedOut })
    }
    const wake = () => done(false)
    queue.push(wake)
    waiters.set(key, queue)
    timer = setTimeout(() => done(true), Math.min(Math.max(timeoutMs, 1000), 600_000))
  })
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

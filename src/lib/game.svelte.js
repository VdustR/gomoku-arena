/**
 * Game state: one board, two seats, a move log, and whatever each provider
 * revealed about the move it chose.
 */

import {
  SIZE,
  BLACK,
  WHITE,
  EMPTY,
  createBoard,
  idx,
  moveLegality,
  resolveMove,
  winningLine,
  coordLabel,
  FORBIDDEN_COPY,
} from './rules.js'
import { chooseMove, PROVIDERS, LOCAL_ID, colorName } from './ai/providers.js'
import { keyFor, configFor } from './settings.svelte.js'
import { config } from './config.js'

/** Seats for a match preset. `pvp` is two humans, `cvc` two engines. */
export function seatsForPreset(preset, provider = LOCAL_ID) {
  const human = { kind: 'human', provider }
  const ai = { kind: 'ai', provider }
  if (preset === 'pvp') return { [BLACK]: { ...human }, [WHITE]: { ...human } }
  if (preset === 'cvc') return { [BLACK]: { ...ai }, [WHITE]: { ...ai } }
  return { [BLACK]: { ...human }, [WHITE]: { ...ai } }
}

export const HUMAN = 'human'

export const game = $state({
  board: createBoard(),
  turn: BLACK,
  status: 'playing', // playing | win | draw
  winner: null,
  winningStones: [],
  ruleSet: config.defaultRuleSet,
  seats: seatsForPreset(config.defaultMatch),
  history: [],
  thinking: false,
  thinkingFor: null,
  candidates: [],
  lastTelemetry: null,
  lastMove: null,
  error: null,
  // Two engines only keep trading moves while this is set, so a match can
  // be paused and read.
  autoplay: config.defaultMatch === 'cvc',
})

let pending = null

export function seatOf(color) {
  return game.seats[color]
}

export function resetGame({ keepSeats = true } = {}) {
  pending?.abort()
  pending = null
  game.board = createBoard()
  game.turn = BLACK
  game.status = 'playing'
  game.winner = null
  game.winningStones = []
  game.history = []
  game.thinking = false
  game.thinkingFor = null
  game.candidates = []
  game.lastTelemetry = null
  game.lastMove = null
  game.error = null
  game.autoplay = config.defaultMatch === 'cvc'
  if (!keepSeats) game.seats = seatsForPreset(config.defaultMatch)
}

/** Apply a move already known to be legal. */
function commit(x, y, color, meta) {
  const outcome = resolveMove(game.board, x, y, color, game.ruleSet)
  const next = game.board.slice()
  next[idx(x, y)] = color
  game.board = next
  game.lastMove = { x, y, color }
  game.history = [
    ...game.history,
    {
      n: game.history.length + 1,
      x,
      y,
      color,
      label: coordLabel(x, y),
      provider: meta?.provider ?? null,
      latencyMs: meta?.latencyMs ?? null,
      confidence: meta?.confidence ?? null,
    },
  ]

  if (outcome.status === 'win') {
    game.status = 'win'
    game.winner = color
    game.winningStones = winningLine(game.board, x, y, color)
    game.autoplay = false
  } else if (outcome.status === 'draw') {
    game.status = 'draw'
    game.autoplay = false
  } else {
    game.turn = color === BLACK ? WHITE : BLACK
  }
}

/** A human click. Returns the rejection reason, or null when the move landed. */
export function playHuman(x, y) {
  if (game.status !== 'playing' || game.thinking) return 'not-your-turn'
  if (seatOf(game.turn).kind !== 'human') return 'not-your-turn'
  const legality = moveLegality(game.board, x, y, game.turn, game.ruleSet)
  if (!legality.legal) return legality.reason
  game.error = null
  commit(x, y, game.turn, { provider: HUMAN })
  return null
}

/** Ask the seated provider for a move and play it. */
export async function playProvider() {
  if (game.status !== 'playing' || game.thinking) return
  const seat = seatOf(game.turn)
  if (seat.kind !== 'ai') return

  const color = game.turn
  const provider = seat.provider
  const key = keyFor(provider)
  const meta = PROVIDERS[provider]

  if (meta?.needsKey && !key) {
    game.error = {
      title: `${meta.name} needs a key`,
      detail: `Add one in Settings to let it play ${colorName(color).toLowerCase()}. Nothing is stored outside this browser.`,
    }
    game.autoplay = false
    return
  }

  pending = new AbortController()
  game.thinking = true
  game.thinkingFor = color
  game.error = null

  try {
    const result = await chooseMove({
      board: game.board,
      color,
      ruleSet: game.ruleSet,
      provider,
      key,
      config: configFor(provider),
      signal: pending.signal,
    })

    game.candidates = result.candidates
    game.lastTelemetry = result.telemetry ? { ...result.telemetry, latencyMs: result.latencyMs, color } : null

    if (!result.move) {
      game.status = 'draw'
      return
    }
    commit(result.move.x, result.move.y, color, {
      provider,
      latencyMs: result.latencyMs,
      confidence: result.telemetry?.confidence ?? null,
    })
  } catch (error) {
    if (error?.name === 'AbortError') return
    game.error = {
      title: `${meta?.name ?? provider} could not answer`,
      detail: String(error?.message ?? error),
    }
    game.autoplay = false
  } finally {
    game.thinking = false
    game.thinkingFor = null
    pending = null
  }
}

export function stopThinking() {
  pending?.abort()
  game.autoplay = false
}

export function undoLastPair() {
  if (game.thinking || game.history.length === 0) return
  // Undoing your own move takes one stone back; undoing an engine's reply
  // takes the reply and the move that prompted it.
  const drop = game.history.at(-1).provider === HUMAN ? 1 : Math.min(2, game.history.length)
  const remaining = game.history.slice(0, -drop)
  const board = createBoard()
  for (const move of remaining) board[idx(move.x, move.y)] = move.color
  game.board = board
  game.history = remaining
  game.status = 'playing'
  game.winner = null
  game.winningStones = []
  game.turn = remaining.length % 2 === 0 ? BLACK : WHITE
  game.lastMove = remaining.at(-1) ? { x: remaining.at(-1).x, y: remaining.at(-1).y, color: remaining.at(-1).color } : null
  game.error = null
  game.autoplay = false
}

export function forbiddenCopyFor(reason) {
  return FORBIDDEN_COPY[reason] ?? null
}

export { BLACK, WHITE, EMPTY, SIZE, idx, coordLabel, colorName }

/**
 * The page's view of a match.
 *
 * The board is not held here: it lives on the server, so a person in this tab
 * and an agent on the MCP endpoint act on the same game. This module mirrors
 * the server's state over an event stream, sends the moves a human makes, and
 * drives whichever in-page engines are seated.
 */

import { BLACK, WHITE, SIZE, createBoard, idx, coordLabel, FORBIDDEN_COPY } from './rules.js'
import { chooseMove, PROVIDERS, DEFAULT_ENGINE_ID, colorName } from './ai/providers.js'
import { keyFor, configFor } from './settings.svelte.js'
import { config } from './config.js'

export const HUMAN = 'human'
/** A seat played from outside this page, over MCP. Nothing here moves it. */
export const AGENT = 'agent'

/** Seats for a match preset, in the shape the server expects. */
export function seatsForPreset(preset, provider = DEFAULT_ENGINE_ID) {
  const human = { kind: 'human', assist: 'free' }
  const engine = { kind: 'engine', provider, assist: 'shortlist' }
  if (preset === 'pvp') return { black: { ...human }, white: { ...human } }
  if (preset === 'cvc') return { black: { ...engine }, white: { ...engine } }
  return { black: { ...human }, white: { ...engine } }
}

export const game = $state({
  matchId: null,
  connected: false,
  board: createBoard(),
  turn: BLACK,
  status: 'playing',
  winner: null,
  winningStones: [],
  ruleSet: config.defaultRuleSet,
  /** Mirrors the server, plus the provider each engine seat should use. */
  seats: seatsForPreset(config.defaultMatch),
  history: [],
  thinking: false,
  thinkingFor: null,
  candidates: [],
  lastTelemetry: null,
  lastMove: null,
  error: null,
  autoplay: config.defaultMatch === 'cvc',
})

let source = null
let pending = null
/** Providers are chosen here, not on the server; keep them across syncs. */
const providerBySeat = { black: DEFAULT_ENGINE_ID, white: DEFAULT_ENGINE_ID }

/** Search settings for the code-only engines, from the build config. */
function engineOptionsFor(provider) {
  if (provider === 'minimax') {
    return {
      depth: config.engines.minimaxDepth,
      width: config.engines.minimaxWidth,
      budgetMs: config.engines.minimaxBudgetMs,
    }
  }
  if (provider === 'mcts') return { budgetMs: config.engines.mctsBudgetMs }
  return undefined
}

const seatKey = (color) => (color === BLACK ? 'black' : 'white')
const colorOf = (seat) => (seat === 'black' ? BLACK : WHITE)

export function seatOf(color) {
  return game.seats[seatKey(color)]
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(payload.message ?? `Request failed with status ${response.status}`)
    error.code = payload.error
    error.reason = payload.reason
    throw error
  }
  return payload
}

/** Fold a server view into the local mirror. */
function applyState(view) {
  const board = createBoard()
  for (let i = 0; i < view.board.cells.length; i += 1) board[i] = view.board.cells[i]
  game.board = board
  game.turn = colorOf(view.turn)
  game.status = view.status
  game.winner = view.winner ? colorOf(view.winner) : null
  game.ruleSet = view.ruleSet
  game.history = view.history.map((move) => ({
    n: move.n,
    label: move.point,
    color: colorOf(move.seat),
    provider: move.by,
    latencyMs: move.latencyMs,
  }))
  game.matchId = view.id

  const last = view.history.at(-1)
  game.lastMove = last ? { ...pointOf(last.point), color: colorOf(last.seat) } : null
  game.winningStones = view.winningStones.map((label) => {
    const { x, y } = pointOf(label)
    return [x, y]
  })

  for (const seat of ['black', 'white']) {
    game.seats[seat] = { ...view.seats[seat], provider: providerBySeat[seat] }
  }
  if (game.status !== 'playing') game.autoplay = false
}

const COLUMNS = 'ABCDEFGHJKLMNOPQRSTUVWXYZ'
function pointOf(label) {
  const match = /^([A-HJ-Z])(\d{1,2})$/.exec(String(label).toUpperCase())
  if (!match) return { x: -1, y: -1 }
  return { x: COLUMNS.indexOf(match[1]), y: SIZE - Number(match[2]) }
}

function listen(matchId) {
  source?.close()
  source = new EventSource(`/api/match/${matchId}/events`)
  source.onmessage = (event) => {
    game.connected = true
    applyState(JSON.parse(event.data))
  }
  source.onerror = () => {
    game.connected = false
  }
}

/** Open a match on the server and start mirroring it. */
export async function startMatch({ preset = config.defaultMatch, ruleSet = game.ruleSet } = {}) {
  pending?.abort()
  pending = null
  const seats = seatsForPreset(preset)
  providerBySeat.black = seats.black.provider ?? DEFAULT_ENGINE_ID
  providerBySeat.white = seats.white.provider ?? DEFAULT_ENGINE_ID

  const view = await request('/api/match', {
    method: 'POST',
    body: JSON.stringify({ ruleSet, black: seats.black, white: seats.white }),
  })
  game.error = null
  game.thinking = false
  game.candidates = []
  game.lastTelemetry = null
  game.autoplay = preset === 'cvc'
  applyState(view)
  listen(view.id)
  return view
}

/** Point this tab at a match someone else opened, e.g. one an agent created. */
export async function joinMatch(matchId) {
  const view = await request(`/api/match/${matchId}`)
  game.error = null
  applyState(view)
  listen(view.id)
  return view
}

export async function setSeat(color, patch) {
  const seat = seatKey(color)
  if (patch.provider) providerBySeat[seat] = patch.provider
  const body = {
    [seat]: {
      kind: patch.kind ?? game.seats[seat].kind,
      assist: patch.assist ?? (patch.kind === AGENT ? 'free' : game.seats[seat].assist),
      label: patch.label ?? null,
    },
  }
  applyState(await request(`/api/match/${game.matchId}`, { method: 'PATCH', body: JSON.stringify(body) }))
}

export async function setRuleSet(ruleSet) {
  applyState(await request(`/api/match/${game.matchId}`, { method: 'PATCH', body: JSON.stringify({ ruleSet }) }))
}

export async function resetGame() {
  pending?.abort()
  game.error = null
  game.thinking = false
  game.candidates = []
  game.lastTelemetry = null
  applyState(await request(`/api/match/${game.matchId}/reset`, { method: 'POST' }))
  game.autoplay = game.seats.black.kind === 'engine' && game.seats.white.kind === 'engine'
}

async function submit(color, label, { by, latencyMs } = {}) {
  return request(`/api/match/${game.matchId}/play`, {
    method: 'POST',
    body: JSON.stringify({ seat: seatKey(color), point: label, by, latencyMs }),
  })
}

/** A human click. Resolves to a rejection reason, or null when the move landed. */
export async function playHuman(x, y) {
  if (game.status !== 'playing' || game.thinking) return 'not-your-turn'
  if (seatOf(game.turn).kind !== HUMAN) return 'not-your-turn'
  try {
    applyState(await submit(game.turn, coordLabel(x, y), { by: 'you' }))
    game.error = null
    return null
  } catch (error) {
    if (error.code === 'illegal_move') return error.reason
    game.error = { title: 'That move did not land', detail: error.message }
    return null
  }
}

/** Ask the engine seated here for a move, then send it. */
export async function playProvider() {
  if (game.status !== 'playing' || game.thinking) return
  const color = game.turn
  const seat = seatOf(color)
  if (seat.kind !== 'engine') return

  const provider = seat.provider ?? DEFAULT_ENGINE_ID
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
      options: engineOptionsFor(provider),
      signal: pending.signal,
    })
    game.candidates = result.candidates
    game.lastTelemetry = result.telemetry ? { ...result.telemetry, latencyMs: result.latencyMs, color } : null
    if (!result.move) return
    applyState(
      await submit(color, result.move.label, { by: meta?.name ?? provider, latencyMs: result.latencyMs }),
    )
  } catch (error) {
    if (error?.name === 'AbortError') return
    game.error = { title: `${meta?.name ?? provider} could not answer`, detail: String(error?.message ?? error) }
    game.autoplay = false
  } finally {
    game.thinking = false
    game.thinkingFor = null
    pending = null
  }
}

/**
 * Take back the last move, or the last two when an engine answered, so the
 * board returns to a point where it is your move again.
 */
export async function undoLastPair() {
  if (game.thinking || game.history.length === 0) return
  const lastWasMine = game.history.at(-1).provider === 'you'
  const count = lastWasMine ? 1 : Math.min(2, game.history.length)
  try {
    applyState(await request(`/api/match/${game.matchId}/undo`, {
      method: 'POST',
      body: JSON.stringify({ count }),
    }))
    game.error = null
    game.autoplay = false
  } catch (error) {
    game.error = { title: 'Could not take that back', detail: error.message }
  }
}

export function stopThinking() {
  pending?.abort()
  game.autoplay = false
}

export function forbiddenCopyFor(reason) {
  return FORBIDDEN_COPY[reason] ?? null
}

export { BLACK, WHITE, SIZE, idx, coordLabel, colorName }

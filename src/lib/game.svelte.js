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
import { serverCovers, serverProblem } from './relay.svelte.js'
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
  /** The hold on this match, if someone put one there. */
  paused: null,
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
  /** The review record, once loaded, and where the reader is in it. */
  review: null,
  reviewAt: 0,
  /** When the side to move was handed the turn, for the waiting indicator. */
  turnSince: Date.now(),
  /**
   * Whether this tab is driving its engine seats right now.
   *
   * One flag, because it answers one question. It used to share the job with
   * an `autoplay` flag set only by the match presets, so making a game
   * engine-versus-engine by changing a seat left the two disagreeing: Start
   * armed the tab, the loop waited on autoplay, and the board sat still while
   * the status claimed a player was thinking.
   *
   * Starting, pausing and resuming are all this. It gates only the seats this
   * page drives — a seat held by an agent moves from its own harness, which no
   * button here can hold back.
   *
   * It starts false on every match for two reasons: Chrome's on-device model
   * refuses to open a session without a real user gesture, and a match that
   * begins the instant the page loads gives nobody a chance to watch it begin.
   */
  armed: false,
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
  game.paused = view.paused ?? null
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

  /*
   * The server does not publish when a turn began, but every change to a
   * match bumps updatedAt, and the change that hands over the turn is the
   * last move. Close enough to show how long a side has been on move, and it
   * needs no round trip of its own.
   */
  game.turnSince = Date.parse(view.updatedAt) || Date.now()
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
/**
 * Open a new match on the server and start mirroring it.
 *
 * `preset` reseats both sides. Passing `seats` instead carries the current
 * ones over, which is what "play again" means — and it opens a *new* match
 * rather than resetting this one, so the game just finished stays reviewable
 * at its own id.
 */
export async function startMatch({ preset, ruleSet = game.ruleSet, seats: keep } = {}) {
  pending?.abort()
  pending = null
  const seats = keep ?? seatsForPreset(preset ?? config.defaultMatch)
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
  game.armed = false
  applyState(view)
  listen(view.id)
  rememberInUrl(view.id)
  return view
}

/**
 * The address bar names the match in front of you.
 *
 * It is the only handle on a game, so getting it wrong is the difference
 * between reloading to recover and reloading to lose what you were doing.
 * Every path that changes which match this tab is showing goes through here.
 */
function rememberInUrl(id) {
  if (typeof location === 'undefined') return
  const next = `#match=${id}`
  if (location.hash !== next) history.replaceState(null, '', next)
}

/** Play again with the same players and rules. The last game stays reviewable. */
export async function playAgain() {
  const seats = {
    black: { ...game.seats.black },
    white: { ...game.seats.white },
  }
  return startMatch({ seats, ruleSet: game.ruleSet })
}

/** Point this tab at a match someone else opened, e.g. one an agent created. */
export async function joinMatch(matchId) {
  const view = await request(`/api/match/${matchId}`)
  game.error = null
  applyState(view)
  listen(view.id)
  rememberInUrl(view.id)
  return view
}

/** Recent matches, newest activity first. */
export async function listMatches() {
  const { matches } = await request('/api/matches')
  return matches
}

export async function setSeat(color, patch) {
  const seat = seatKey(color)
  if (patch.provider) providerBySeat[seat] = patch.provider
  const body = {
    [seat]: {
      kind: patch.kind ?? game.seats[seat].kind,
      assist: patch.assist ?? (patch.kind === AGENT ? 'free' : game.seats[seat].assist),
      label: patch.label ?? game.seats[seat].label ?? null,
    },
  }
  applyState(await request(`/api/match/${game.matchId}`, { method: 'PATCH', body: JSON.stringify(body) }))
}

export async function setRuleSet(ruleSet) {
  applyState(await request(`/api/match/${game.matchId}`, { method: 'PATCH', body: JSON.stringify({ ruleSet }) }))
}

/**
 * Put this match on hold, or take it off hold.
 *
 * Distinct from Pause, which holds only the engines this tab drives. A hold
 * reaches the record: moves are refused, a wait returns rather than pretending
 * a turn is coming, and anyone else looking at the game sees it held instead
 * of live and stuck.
 */
export async function holdMatch(paused = true, note = null) {
  if (!game.matchId) return
  if (paused) disarm()
  try {
    applyState(
      await request(`/api/match/${game.matchId}/pause`, {
        method: 'POST',
        body: JSON.stringify({ paused, by: 'a person at the board', note }),
      }),
    )
    game.error = null
  } catch (error) {
    game.error = { title: paused ? 'Could not hold the game' : 'Could not resume the game', detail: error.message }
  }
}

export async function resetGame() {
  pending?.abort()
  game.error = null
  game.thinking = false
  game.candidates = []
  game.lastTelemetry = null
  applyState(await request(`/api/match/${game.matchId}/reset`, { method: 'POST' }))
  game.armed = false
}

async function submit(color, label, { by, latencyMs, note, metrics } = {}) {
  return request(`/api/match/${game.matchId}/play`, {
    method: 'POST',
    body: JSON.stringify({ seat: seatKey(color), point: label, by, latencyMs, note, metrics }),
  })
}

/**
 * What this player can actually account for. A search engine counts its own
 * work; a model's endpoint returns real token counts. Both are measured, as
 * opposed to an agent reporting its own usage over MCP.
 */
function metricsFrom(telemetry) {
  if (!telemetry) return null
  const metrics = { source: 'measured', model: telemetry.model }
  if (telemetry.confidence != null) metrics.confidence = telemetry.confidence
  const usage = telemetry.usage ?? {}
  for (const [from, to] of [
    ['input_tokens', 'input_tokens'],
    ['output_tokens', 'output_tokens'],
    ['prompt_tokens', 'input_tokens'],
    ['completion_tokens', 'output_tokens'],
  ]) {
    if (typeof usage[from] === 'number') metrics[to] = usage[from]
  }
  // Search engines report their work in the notes line; keep it verbatim.
  if (telemetry.notes) metrics.work = telemetry.notes
  return metrics
}

/** Start or resume driving the engine seats. Must come from a real click. */
export function arm() {
  game.armed = true
}

/** Hold the engine seats where they are. The gate comes back as Resume. */
export function disarm() {
  pending?.abort()
  game.armed = false
}

/** A human click. Resolves to a rejection reason, or null when the move landed. */
export async function playHuman(x, y) {
  if (game.status !== 'playing' || game.thinking) return 'not-your-turn'
  if (seatOf(game.turn).kind !== HUMAN) return 'not-your-turn'
  // Playing by hand is itself the gesture that arms the rest of the match.
  game.armed = true
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
  /*
   * A key can come from here or from the server's environment, and the server
   * one is invisible to this page by design. Refusing on the browser's key
   * alone is what made an environment-supplied key unusable from the page:
   * the relay that would have supplied it was never called.
   */
  if (meta?.needsKey && !key && !serverCovers(provider)) {
    const problem = serverProblem(provider)
    game.error = {
      title: `${meta.name} needs a key`,
      detail: problem
        ? `${problem} Until then, add a key in Settings to let it play ${colorName(color).toLowerCase()}.`
        : `Add one in Settings to let it play ${colorName(color).toLowerCase()}, or set one on the server. A key typed here is kept in this browser.`,
    }
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
      await submit(color, result.move.label, {
        by: meta?.name ?? provider,
        latencyMs: result.latencyMs,
        note: result.telemetry?.notes ?? null,
        metrics: metricsFrom(result.telemetry),
      }),
    )
  } catch (error) {
    if (error?.name === 'AbortError') return
    game.error = { title: `${meta?.name ?? provider} could not answer`, detail: String(error?.message ?? error) }
    /*
     * Hand the decision back rather than asking again.
     *
     * The loop that drives engine seats re-fires as soon as this stops
     * thinking, so a provider that fails is asked again every moveDelayMs —
     * a retry loop against an endpoint someone is paying for, and one that
     * buries the reason under the next identical failure. Disarming puts
     * Resume back in front of the person who can fix it.
     */
    game.armed = false
  } finally {
    game.thinking = false
    game.thinkingFor = null
    pending = null
  }
}

/**
 * How many moves Take back would remove: the last one, or the last two when
 * someone else answered, so the board returns to a point where it is your
 * move again. Exported because the button has to say this before it acts.
 */
export function takeBackCount() {
  if (game.history.length === 0) return 0
  const lastWasMine = game.history.at(-1).provider === 'you'
  return lastWasMine ? 1 : Math.min(2, game.history.length)
}

/**
 * Whether anyone in this match is playing from outside this page.
 *
 * Take back is a control on one screen, but it changes a board a seat held
 * over MCP is deciding against. That player cannot see this button, so the
 * button has to account for it.
 */
export function hasAgentSeat() {
  return game.seats.black.kind === AGENT || game.seats.white.kind === AGENT
}

/**
 * Take back the last move, or the last two when an engine answered, so the
 * board returns to a point where it is your move again.
 */
export async function undoLastPair() {
  if (game.thinking || game.history.length === 0) return
  const count = takeBackCount()
  try {
    applyState(await request(`/api/match/${game.matchId}/undo`, {
      method: 'POST',
      body: JSON.stringify({ count }),
    }))
    game.error = null
  } catch (error) {
    game.error = { title: 'Could not take that back', detail: error.message }
  }
}

/** Fetch the review record for the current match. */
export async function loadReview() {
  if (!game.matchId) return null
  try {
    const review = await request(`/api/match/${game.matchId}/review`)
    game.review = review
    game.reviewAt = review.moves.length
    game.error = null
    return review
  } catch (error) {
    game.error = { title: 'Could not load the review', detail: error.message }
    return null
  }
}

export function closeReview() {
  game.review = null
  game.reviewAt = 0
}

/** Move the reader through the record; the board follows. */
export function seekReview(index) {
  if (!game.review) return
  game.reviewAt = Math.min(Math.max(0, index), game.review.moves.length)
}

/** The board as it stood after `reviewAt` moves. */
export function reviewBoard() {
  if (!game.review) return game.board
  const frame = game.review.positions[game.reviewAt] ?? game.review.positions.at(-1)
  const board = createBoard()
  for (let i = 0; i < frame.length; i += 1) board[i] = frame[i]
  return board
}

export function stopThinking() {
  pending?.abort()
  game.armed = false
}

export function forbiddenCopyFor(reason) {
  return FORBIDDEN_COPY[reason] ?? null
}

export { BLACK, WHITE, SIZE, idx, coordLabel, colorName }

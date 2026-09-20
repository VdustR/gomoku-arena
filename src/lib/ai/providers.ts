/**
 * Providers.
 *
 * Every provider answers the same question — given this position and this
 * shortlist, which move? — and returns the same shape, so the board and the
 * telemetry panel never learn which engine produced a move.
 *
 * Keys are supplied by the person using the page, held in localStorage, and
 * sent per request. Nothing ships with a key. Remote providers go through the
 * relay on the server you started, because they refuse browser origins; the
 * relay forwards one request and keeps no copy of the key.
 */

import { candidateMoves, describePosition } from './heuristic.ts'
import type { Candidate, PositionSummary } from './heuristic.ts'
import { ENGINES } from './engines.ts'
import { config as buildConfig } from '../config.ts'
import { BLACK } from '../rules.ts'
import type { Board, RuleSetId, Side } from '../rules.ts'
import type {
  Choice,
  Decision,
  EngineOptions,
  ModelAdapter,
  ModelRequest,
  ProviderConfig,
  Telemetry,
} from './contract.ts'

/**
 * Chrome's Prompt API, as much of it as this file uses.
 *
 * Declared here rather than imported: it is a browser API that ships ahead of
 * its type definitions, and naming the members actually called is more honest
 * than an `any` that claims to know the rest of the surface.
 */
interface PromptSession {
  prompt(
    text: string,
    options?: { responseConstraint?: unknown; signal?: AbortSignal | undefined },
  ): Promise<string>
  measureInputUsage?(text: string): Promise<number>
  inputQuota?: number
  inputUsage?: number
  destroy?(): void
}

interface PromptApi {
  availability?(): Promise<string>
  create(options: {
    initialPrompts?: { role: string; content: string }[]
    signal?: AbortSignal | undefined
  }): Promise<PromptSession>
}

declare global {
  // eslint-disable-next-line no-var
  var LanguageModel: PromptApi | undefined
  // eslint-disable-next-line no-var
  var ai: { languageModel?: PromptApi } | undefined
}

/** One provider, as the seat picker and the settings dialog read it. */
export interface ProviderMeta {
  id: string
  group: 'seat' | 'search' | 'model'
  note: string
  name: string
  tagline: string
  needsKey: boolean
  keyHint?: string
  isEngine?: boolean
  source?: { label: string; url: string | null }
  docs: string | null
  /** What the page does for this seat before the model is asked. */
  assistance?: Assistance
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const aborted = (error: unknown): boolean => error instanceof Error && error.name === 'AbortError'

/** Chrome's built-in model is on-device: no key, no network, no cost. */
export const BROWSER_ID = 'browser'
export const JEV_ID = 'jev'
export const OPENAI_ID = 'openai'

/**
 * What the page does for a model seat before the model is asked anything.
 *
 * Measuring a model and fielding a strong player are different jobs, and the
 * default profile is tuned for the second. It narrows ~220 legal points to
 * eight, sorts them by the heuristic's own score, writes what each one does
 * ("makes an open three and blocks the opponent's four"), and plays the move
 * itself when a five is available either way. A seat set up like that can post
 * a full game without the model having contributed a decision — which is
 * exactly what happened once, undetected, because the record looks identical.
 *
 * So the profile is named and attached to the provider rather than left
 * implicit, and the variants below differ only in this.
 */
export interface Assistance {
  /** How many points the seat may choose between. `null` offers the board. */
  candidateLimit: number | null
  /** Whether each point arrives with the heuristic's reading of it. */
  rationale: boolean
  /** Whether the page takes or blocks a five without asking the model. */
  forced: boolean
  /**
   * Whether the points are handed over in the heuristic's ranking.
   *
   * Order is an answer. Offering the heuristic's favourite first tells the
   * model which one that is, so a seat meant to measure the model hands them
   * over in board order and lets the model do the ranking.
   */
  ranked: boolean
}

/** The long-standing behaviour: every aid on. Strongest play, weakest evidence. */
const AIDED: Assistance = {
  candidateLimit: buildConfig.candidateLimit,
  rationale: true,
  forced: true,
  ranked: true,
}

/** The heuristic picks the field; the model reads it and ranks it. */
const SHORTLISTED: Assistance = {
  candidateLimit: buildConfig.candidateLimit,
  rationale: false,
  forced: false,
  ranked: false,
}

/** Every legal point, no reading, no shortcut. The model or nothing. */
const UNAIDED: Assistance = { candidateLimit: null, rationale: false, forced: false, ranked: false }

export const JEV_SHORTLISTED_ID = 'jev-shortlisted'
export const JEV_UNAIDED_ID = 'jev-unaided'
export const BROWSER_SHORTLISTED_ID = 'browser-shortlisted'
export const BROWSER_UNAIDED_ID = 'browser-unaided'

/**
 * Which adapter, key and endpoint a variant belongs to. A variant changes what
 * the page does around the model, never which model it is.
 */
const VARIANT_OF: Record<string, string> = {
  [JEV_SHORTLISTED_ID]: JEV_ID,
  [JEV_UNAIDED_ID]: JEV_ID,
  [BROWSER_SHORTLISTED_ID]: BROWSER_ID,
  [BROWSER_UNAIDED_ID]: BROWSER_ID,
}

/** The provider a variant is a variant of, or the id itself. */
export const baseProviderOf = (provider: string): string => VARIANT_OF[provider] ?? provider

export const assistanceFor = (provider: string): Assistance => PROVIDERS[provider]?.assistance ?? AIDED
/** Engines that are only code. Their ids are the keys of ENGINES. */
export const ENGINE_IDS = Object.keys(ENGINES)
export const DEFAULT_ENGINE_ID = 'greedy'

/**
 * How the seat picker groups its options. The split is by what a person is
 * actually choosing between — who drives the seat, and what it costs to use —
 * rather than by whether something counts as "AI", which would file a free
 * on-device model beside a metered remote one.
 */
export const PROVIDER_GROUPS: Record<'seat' | 'search' | 'model', { id: string; label: string }> = {
  seat: { id: 'seat', label: 'People and agents' },
  search: { id: 'search', label: 'Search algorithms' },
  model: { id: 'model', label: 'Models' },
}

export const PROVIDERS: Record<string, ProviderMeta> = {
  [BROWSER_ID]: {
    id: BROWSER_ID,
    group: 'model',
    note: 'on-device, no key',
    name: 'Chrome built-in AI',
    tagline: 'On-device Gemini Nano. No key, no network, no cost.',
    needsKey: false,
    docs: 'https://developer.chrome.com/docs/ai/prompt-api',
  },
  [JEV_ID]: {
    id: JEV_ID,
    group: 'model',
    note: 'needs a key',
    name: 'Jev-compatible',
    tagline: 'A typed decision with a probability for every candidate. TypeSafe, or your own server.',
    needsKey: true,
    keyHint: 'console.typesafe.ai, or whatever your own endpoint expects',
    docs: 'https://docs.typesafe.ai/api',
  },
  [JEV_SHORTLISTED_ID]: {
    id: JEV_SHORTLISTED_ID,
    group: 'model',
    note: 'needs a key',
    name: 'Jev — shortlisted',
    tagline: 'The heuristic picks eight points. The model reads them itself and ranks them.',
    needsKey: true,
    keyHint: 'console.typesafe.ai, or whatever your own endpoint expects',
    docs: 'https://docs.typesafe.ai/api',
    assistance: SHORTLISTED,
  },
  [JEV_UNAIDED_ID]: {
    id: JEV_UNAIDED_ID,
    group: 'model',
    note: 'needs a key',
    name: 'Jev — unaided',
    tagline: 'Every legal point, no reading of them, no shortcut. What the model can do alone.',
    needsKey: true,
    keyHint: 'console.typesafe.ai, or whatever your own endpoint expects',
    docs: 'https://docs.typesafe.ai/api',
    assistance: UNAIDED,
  },
  [BROWSER_SHORTLISTED_ID]: {
    id: BROWSER_SHORTLISTED_ID,
    group: 'model',
    note: 'on-device, no key',
    name: 'Chrome built-in — shortlisted',
    tagline: 'The heuristic picks eight points. The model reads them itself and ranks them.',
    needsKey: false,
    docs: 'https://developer.chrome.com/docs/ai/prompt-api',
    assistance: SHORTLISTED,
  },
  [BROWSER_UNAIDED_ID]: {
    id: BROWSER_UNAIDED_ID,
    group: 'model',
    note: 'on-device, no key',
    name: 'Chrome built-in — unaided',
    tagline: 'Every legal point, no reading of them, no shortcut. Needs a context this model may not have.',
    needsKey: false,
    docs: 'https://developer.chrome.com/docs/ai/prompt-api',
    assistance: UNAIDED,
  },
  [OPENAI_ID]: {
    id: OPENAI_ID,
    group: 'model',
    note: 'needs a key',
    name: 'OpenAI-compatible',
    tagline: 'Any endpoint that speaks /chat/completions, including a local one.',
    needsKey: true,
    keyHint: 'your provider’s dashboard',
    docs: 'https://platform.openai.com/docs/api-reference/chat',
  },
  ...Object.fromEntries(
    Object.values(ENGINES).map((engine) => [
      engine.id,
      {
        id: engine.id,
        group: 'search',
        note: engine.note,
        name: engine.name,
        tagline: engine.tagline,
        needsKey: false,
        isEngine: true,
        source: engine.source,
        docs: engine.source?.url ?? null,
      },
    ]),
  ),
}

/**
 * Is Chrome's built-in model usable here? Returns the availability string so
 * the UI can tell "this browser cannot" from "the model needs downloading".
 */
/** What this browser can do with the on-device model, and how it says so. */
export interface BrowserModelState {
  supported: boolean
  ready?: boolean
  state: string
  detail: string
}

export async function detectBrowserModel(): Promise<BrowserModelState> {
  const api = globalThis.LanguageModel ?? globalThis.ai?.languageModel
  if (!api?.availability) {
    return { supported: false, state: 'absent', detail: 'This browser does not expose the Prompt API.' }
  }
  try {
    const state = await api.availability()
    // The spec renamed these; accept both spellings.
    const ready = state === 'available' || state === 'readily' || state === 'readily-available'
    const downloadable = state === 'downloadable' || state === 'after-download' || state === 'downloading'
    return {
      supported: ready || downloadable,
      ready,
      state,
      detail: ready
        ? 'On-device model ready.'
        : downloadable
          ? 'Available once Chrome finishes downloading the model. The first move triggers it.'
          : 'Chrome reports the model as unavailable on this device.',
    }
  } catch (error) {
    return { supported: false, state: 'error', detail: message(error) }
  }
}

const moveSchema = (count: number) => ({
  type: 'object',
  required: ['choice'],
  additionalProperties: false,
  properties: {
    choice: { type: 'integer', minimum: 0, maximum: Math.max(count - 1, 0) },
  },
})

/**
 * Read a shortlist index out of whatever a model replied with.
 *
 * The constrained-output path gives `{"choice": 2}`, but a model can ignore
 * the constraint and answer in prose, or prepend a status line. Falling back
 * to the first in-range integer keeps a usable move rather than failing the
 * turn over formatting.
 */
export function parseChoiceIndex(raw: unknown, count: number): number {
  const inRange = (value: number): boolean => Number.isInteger(value) && value >= 0 && value < count

  try {
    const parsed: unknown = JSON.parse(String(raw))
    const direct = Number(
      typeof parsed === 'object' && parsed !== null ? (parsed as { choice?: unknown }).choice : parsed,
    )
    if (inRange(direct)) return direct
  } catch {
    // Not JSON. Fall through to reading a number out of the text.
  }

  for (const match of String(raw).matchAll(/\d+/g)) {
    const value = Number(match[0])
    if (inRange(value)) return value
  }

  throw new Error(
    `The model did not name one of the ${count} candidate moves. It replied: ${String(raw).trim().slice(0, 120)}`,
  )
}

function promptFor(position: PositionSummary, candidates: readonly Candidate[]): string {
  const lines = candidates.map((move, i) => `${i}. ${move.label} — ${move.rationale}`)
  return [
    `You are playing ${position.you_play} in ${position.rule_set} gomoku on a ${position.board_size} board.`,
    position.objective,
    '',
    `Your stones: ${position.your_stones}`,
    `Opponent stones: ${position.opponent_stones}`,
    '',
    'Choose the best move from this shortlist by its number:',
    ...lines,
    '',
    'Answer with the number only.',
  ].join('\n')
}

/**
 * The same question, small enough for an on-device model.
 *
 * A stone list grows with the game, so a prompt carrying one gets longer every
 * move until it exceeds the context an on-device model has — which is how a
 * match died at move 17 with "The input is too large". The candidates already
 * carry what the choice turns on ("makes an open three and blocks the
 * opponent's four"), so the position itself can go.
 */
function compactPromptFor(position: PositionSummary, candidates: readonly Candidate[]): string {
  return [
    `Gomoku, you are ${position.you_play}. Pick the best move.`,
    ...candidates.map((move, i) => `${i}. ${move.label} — ${move.rationale}`),
    'Answer with the number only.',
  ].join('\n')
}

const browserMove: ModelAdapter = async ({ position, candidates, signal }) => {
  const api = globalThis.LanguageModel ?? globalThis.ai?.languageModel
  if (!api) throw new Error('The Prompt API is not available in this browser.')
  const started = performance.now()
  let session: PromptSession
  try {
    session = await api.create({
      initialPrompts: [
        {
          role: 'system',
          content:
            'You are a strong gomoku player. You will be given a position and a numbered shortlist of legal moves. Reply with the number of the move you choose and nothing else.',
        },
      ],
      signal,
    })
  } catch (error) {
    if (aborted(error)) throw error
    throw new Error(
      `Chrome would not start an on-device session: ${message(error)}. The model may still be downloading.`,
    )
  }
  try {
    /*
     * Prefer the full position, but only when this model can hold it. Newer
     * builds expose the quota and a way to measure against it; where they do
     * not, the compact prompt is the safe default, because the failure it
     * avoids ends the game rather than degrading it.
     */
    let prompt = compactPromptFor(position, candidates)
    let usedCompact = true
    if (typeof session.measureInputUsage === 'function' && typeof session.inputQuota === 'number') {
      const full = promptFor(position, candidates)
      const needed = await session.measureInputUsage(full)
      const room = session.inputQuota - (session.inputUsage ?? 0)
      // Leave headroom for the schema and the reply.
      if (needed < room * 0.6) {
        prompt = full
        usedCompact = false
      }
    }

    const raw = await session.prompt(prompt, {
      responseConstraint: moveSchema(candidates.length),
      signal,
    })
    const latencyMs = Math.round(performance.now() - started)
    const index = parseChoiceIndex(raw, candidates.length)
    const move = candidates[index] ?? null
    return {
      move,
      latencyMs,
      telemetry: {
        provider: BROWSER_ID,
        model: 'Gemini Nano (on-device)',
        ranked: candidates.map((c, i) => ({ label: c.label, weight: i === index ? 1 : 0 })),
        notes: usedCompact
          ? 'Structured output over a shortlist, with the position trimmed to fit on-device context.'
          : 'Structured output over a shortlist, with the full position.',
      },
    }
  } catch (error) {
    if (aborted(error)) throw error
    if (message(error).includes('too large')) {
      throw new Error(
        'The on-device model could not hold this position. Lower VITE_CANDIDATE_LIMIT, or seat a provider with more context.',
      )
    }
    throw error
  } finally {
    session.destroy?.()
  }
}

/**
 * What the relay wraps an upstream answer in: the body it got back, plus the
 * round trip it measured on the server's side.
 */
interface Envelope<Body> {
  ok: boolean
  status: number
  latencyMs: number
  body: Body
}

/** The shape of an error body, whichever provider produced it. */
interface UpstreamError {
  error?: unknown
  detail?: unknown
}

/** One relayed POST. The envelope carries the upstream body and its timing. */
async function relay<Body>(
  route: string,
  payload: unknown,
  key: string,
  signal: AbortSignal | undefined,
): Promise<Envelope<Body>> {
  let response: Response
  try {
    response = await fetch(route, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-provider-key': key },
      body: JSON.stringify(payload),
      // `signal: undefined` is not the same as no signal under
      // `exactOptionalPropertyTypes`, and `fetch` means the latter.
      ...(signal ? { signal } : {}),
    })
  } catch (error) {
    if (aborted(error)) throw error
    throw new Error('The relay did not answer. Is the server still running?')
  }
  const envelope = (await response.json()) as Envelope<Body & UpstreamError>
  if (!envelope.ok) {
    const detail =
      envelope.body?.error ?? envelope.body?.detail ?? `Request failed with status ${envelope.status}`
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail))
  }
  return envelope
}

/** A typed decision endpoint's answer to one question. */
interface JevAnswer {
  choice?: string
  confidence?: number
  score?: number
  legend?: string[]
  probabilities?: Record<string, number>
}

interface JevBody {
  model?: string
  usage?: Record<string, number>
  answers?: Record<string, JevAnswer | undefined>
}

interface ChatBody {
  model?: string
  usage?: Record<string, number>
  choices?: { message?: { content?: string } }[]
}

const jevMove: ModelAdapter = async ({ position, candidates, key, config, signal }) => {
  const criteria: Record<string, string> = {}
  for (const move of candidates) criteria[move.label] = move.rationale

  const envelope = await relay<JevBody>(
    '/api/jev',
    {
      baseUrl: config.baseUrl,
      request: {
        state: position,
        model: config.model || 'jev-latest',
        questions: {
          move: {
            type: 'choice',
            instructions:
              'Which move should you play next? Weigh your own winning threats against the opponent’s.',
            criteria,
          },
          pressure: {
            type: 'score',
            instructions: 'How much danger are you in right now, judging by the opponent’s strongest threat?',
            criteria: [
              'Comfortable. No opponent threat needs an answer this move.',
              'Watchful. The opponent is building, but nothing forces your hand.',
              'Pressed. The opponent has a serious threat you must answer soon.',
              'Critical. The opponent wins next move unless you block now.',
            ],
          },
        },
      },
    },
    key,
    signal,
  )

  const answers = envelope.body.answers ?? {}
  const chosen = answers['move']
  const move = candidates.find((c) => c.label === chosen?.choice) ?? candidates[0] ?? null
  const probabilities = chosen?.probabilities ?? {}
  const pressure = answers['pressure']

  const telemetry: Telemetry = {
    provider: JEV_ID,
    model: envelope.body.model ?? config.model ?? 'jev',
    ranked: candidates.map((c) => ({ label: c.label, weight: probabilities[c.label] ?? 0 })),
    pressure:
      pressure && typeof pressure.score === 'number'
        ? {
            score: pressure.score,
            confidence: pressure.confidence,
            legend: pressure.legend,
            top: pressure.legend?.[Math.round(pressure.score)],
          }
        : null,
    notes: 'Typed choice with a probability over every candidate.',
  }
  // Absent rather than present-and-undefined: a figure nobody reported is not
  // a figure reported as nothing, and the review reads the difference.
  if (chosen?.confidence !== undefined) telemetry.confidence = chosen.confidence
  if (envelope.body.usage) telemetry.usage = envelope.body.usage

  return { move, latencyMs: envelope.latencyMs, telemetry }
}

const openaiMove: ModelAdapter = async ({ position, candidates, key, config, signal }) => {
  const envelope = await relay<ChatBody>(
    '/api/openai',
    {
      baseUrl: config.baseUrl,
      request: {
        model: config.model,
        messages: [
          {
            role: 'system',
            content:
              'You are a strong gomoku player. Reply with JSON only, in the form {"choice": <index>}, choosing from the numbered shortlist you are given.',
          },
          { role: 'user', content: promptFor(position, candidates) },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
      },
    },
    key,
    signal,
  )

  const content = envelope.body.choices?.[0]?.message?.content ?? ''
  const index = parseChoiceIndex(content, candidates.length)
  const move = candidates[index] ?? null

  const telemetry: Telemetry = {
    provider: OPENAI_ID,
    model: envelope.body.model ?? config.model ?? 'chat',
    ranked: candidates.map((c, i) => ({ label: c.label, weight: i === index ? 1 : 0 })),
    notes: 'Free-text completion parsed back to a shortlist index.',
  }
  if (envelope.body.usage) telemetry.usage = envelope.body.usage

  return { move, latencyMs: envelope.latencyMs, telemetry }
}

/**
 * A code-only engine. These search the board themselves rather than picking
 * from a shortlist, so they are handed the position and nothing else.
 */
function engineMove({
  board,
  color,
  ruleSet,
  provider,
  options,
}: {
  board: Board
  color: Side
  ruleSet: RuleSetId
  provider: string
  options: EngineOptions | undefined
}): Choice {
  const engine = ENGINES[provider]
  if (!engine) return { move: null, latencyMs: 0, telemetry: null }
  const result = engine.run(board, color, ruleSet, options)
  if (!result) return { move: null, latencyMs: 0, telemetry: null }
  return {
    move: { x: result.x, y: result.y, label: result.point },
    latencyMs: result.latencyMs,
    telemetry: { provider, ...result.telemetry },
  }
}

/**
 * Pick a move for `color`. Resolves with the chosen candidate, how long the
 * provider took, and whatever the provider exposed about its reasoning.
 */
export interface MoveRequest {
  board: Board
  color: Side
  ruleSet: RuleSetId
  provider: string
  key?: string
  config?: ProviderConfig
  options?: EngineOptions | undefined
  signal?: AbortSignal | undefined
}

export async function chooseMove({
  board,
  color,
  ruleSet,
  provider,
  key = '',
  config = {},
  options,
  signal,
}: MoveRequest): Promise<Decision> {
  // A code-only engine reasons over the whole board; a shortlist would only
  // cap how well it can play.
  if (ENGINES[provider]) {
    return { ...engineMove({ board, color, ruleSet, provider, options }), candidates: [] }
  }

  const aid = assistanceFor(provider)
  const scored = candidateMoves(board, color, ruleSet, {
    limit: aid.candidateLimit,
    scope: aid.candidateLimit == null ? 'board' : 'relevant',
  })
  if (scored.length === 0) return { move: null, candidates: scored, latencyMs: 0, telemetry: null }

  /*
   * Strip what this profile does not grant. The rationale is the heuristic's
   * reading of the point, and handing it over is handing over the tactics; the
   * ranking is carried by the order, so an unranked profile is shuffled back
   * into board order rather than merely re-sorted by score.
   */
  const candidates = aid.rationale ? scored : scored.map((c) => ({ ...c, rationale: '' }))
  if (!aid.ranked) candidates.sort((a, b) => a.y - b.y || a.x - b.x)

  const position = describePosition(board, color, ruleSet)
  const args: ModelRequest = { position, candidates, key, config, signal }

  // A decisive move is not worth a round trip: take the win, block the loss.
  // A profile that does not grant it asks the model even here, which is the
  // whole point of that profile: 55 of 58 shortcuts taken in one tournament
  // were blocks, so this is where a model's defence is usually hidden.
  const forced = aid.forced
    ? (candidates.find((c) => c.attack === 'five') ?? candidates.find((c) => c.defend === 'five'))
    : undefined
  if (forced) {
    return {
      move: forced,
      candidates,
      latencyMs: 0,
      telemetry: {
        provider,
        model: 'forced move',
        ranked: [{ label: forced.label, weight: 1 }],
        notes:
          forced.attack === 'five' ? 'Winning move played without asking.' : 'Only move that stops five.',
      },
    }
  }

  const base = baseProviderOf(provider)
  const run = base === BROWSER_ID ? browserMove : base === JEV_ID ? jevMove : openaiMove

  const result = await run(args)
  return { ...result, candidates }
}

export const colorName = (color: Side): string => (color === BLACK ? 'Black' : 'White')

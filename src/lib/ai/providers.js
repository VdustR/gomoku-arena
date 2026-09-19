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

import { candidateMoves, heuristicPick, describePosition } from './heuristic.js'
import { BLACK } from '../rules.js'

/** Chrome's built-in model is on-device: no key, no network, no cost. */
export const BROWSER_ID = 'browser'
export const JEV_ID = 'jev'
export const OPENAI_ID = 'openai'
export const LOCAL_ID = 'local'

export const PROVIDERS = {
  [BROWSER_ID]: {
    id: BROWSER_ID,
    name: 'Chrome built-in AI',
    tagline: 'On-device Gemini Nano. No key, no network, no cost.',
    needsKey: false,
    docs: 'https://developer.chrome.com/docs/ai/prompt-api',
  },
  [JEV_ID]: {
    id: JEV_ID,
    name: 'Jev-compatible',
    tagline: 'A typed decision with a probability for every candidate. TypeSafe, or your own server.',
    needsKey: true,
    keyHint: 'console.typesafe.ai, or whatever your own endpoint expects',
    docs: 'https://docs.typesafe.ai/api',
  },
  [OPENAI_ID]: {
    id: OPENAI_ID,
    name: 'OpenAI-compatible',
    tagline: 'Any endpoint that speaks /chat/completions, including a local one.',
    needsKey: true,
    keyHint: 'your provider’s dashboard',
    docs: 'https://platform.openai.com/docs/api-reference/chat',
  },
  [LOCAL_ID]: {
    id: LOCAL_ID,
    name: 'Built-in heuristic',
    tagline: 'Pattern scoring in the page itself. Always available, never calls out.',
    needsKey: false,
    docs: null,
  },
}

/**
 * Is Chrome's built-in model usable here? Returns the availability string so
 * the UI can tell "this browser cannot" from "the model needs downloading".
 */
export async function detectBrowserModel() {
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
    return { supported: false, state: 'error', detail: String(error?.message ?? error) }
  }
}

const moveSchema = (count) => ({
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
export function parseChoiceIndex(raw, count) {
  const inRange = (value) => Number.isInteger(value) && value >= 0 && value < count

  try {
    const parsed = JSON.parse(raw)
    const direct = Number(typeof parsed === 'object' && parsed !== null ? parsed.choice : parsed)
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

function promptFor(position, candidates) {
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

async function browserMove({ position, candidates, signal }) {
  const api = globalThis.LanguageModel ?? globalThis.ai?.languageModel
  if (!api) throw new Error('The Prompt API is not available in this browser.')
  const started = performance.now()
  let session
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
    if (error?.name === 'AbortError') throw error
    throw new Error(
      `Chrome would not start an on-device session: ${error?.message ?? error}. The model may still be downloading.`,
    )
  }
  try {
    const raw = await session.prompt(promptFor(position, candidates), {
      responseConstraint: moveSchema(candidates.length),
      signal,
    })
    const latencyMs = Math.round(performance.now() - started)
    const index = parseChoiceIndex(raw, candidates.length)
    const move = candidates[index]
    return {
      move,
      latencyMs,
      telemetry: {
        provider: BROWSER_ID,
        model: 'Gemini Nano (on-device)',
        ranked: candidates.map((c, i) => ({ label: c.label, weight: i === index ? 1 : 0 })),
        notes: 'Structured output constrained to a shortlist index.',
      },
    }
  } finally {
    session.destroy?.()
  }
}

/** One relayed POST. The envelope carries the upstream body and its timing. */
async function relay(route, payload, key, signal) {
  let response
  try {
    response = await fetch(route, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-provider-key': key },
      body: JSON.stringify(payload),
      signal,
    })
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    throw new Error('The relay did not answer. Is the server still running?')
  }
  const envelope = await response.json()
  if (!envelope.ok) {
    const detail = envelope.body?.error ?? envelope.body?.detail ?? `Request failed with status ${envelope.status}`
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail))
  }
  return envelope
}

async function jevMove({ position, candidates, key, config, signal }) {
  const criteria = {}
  for (const move of candidates) criteria[move.label] = move.rationale

  const envelope = await relay(
    '/api/jev',
    {
      baseUrl: config.baseUrl,
      request: {
        state: position,
        model: config.model || 'jev-latest',
        questions: {
          move: {
            type: 'choice',
            instructions: 'Which move should you play next? Weigh your own winning threats against the opponent’s.',
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
  const chosenLabel = answers.move?.choice
  const move = candidates.find((c) => c.label === chosenLabel) ?? candidates[0]
  const probabilities = answers.move?.probabilities ?? {}

  return {
    move,
    latencyMs: envelope.latencyMs,
    telemetry: {
      provider: JEV_ID,
      model: envelope.body.model ?? config.model,
      confidence: answers.move?.confidence,
      ranked: candidates.map((c) => ({ label: c.label, weight: probabilities[c.label] ?? 0 })),
      pressure: answers.pressure
        ? {
            score: answers.pressure.score,
            confidence: answers.pressure.confidence,
            legend: answers.pressure.legend,
            top: answers.pressure.legend?.[Math.round(answers.pressure.score)],
          }
        : null,
      usage: envelope.body.usage,
      notes: 'Typed choice with a probability over every candidate.',
    },
  }
}

async function openaiMove({ position, candidates, key, config, signal }) {
  const envelope = await relay(
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
  const move = candidates[index]

  return {
    move,
    latencyMs: envelope.latencyMs,
    telemetry: {
      provider: OPENAI_ID,
      model: envelope.body.model ?? config.model,
      ranked: candidates.map((c, i) => ({ label: c.label, weight: i === index ? 1 : 0 })),
      usage: envelope.body.usage,
      notes: 'Free-text completion parsed back to a shortlist index.',
    },
  }
}

function localMove({ candidates }) {
  const started = performance.now()
  const move = heuristicPick(candidates)
  const top = Math.max(...candidates.map((c) => c.score), 1)
  return {
    move,
    latencyMs: Math.max(1, Math.round(performance.now() - started)),
    telemetry: {
      provider: LOCAL_ID,
      model: 'pattern scoring',
      ranked: candidates.map((c) => ({ label: c.label, weight: c.score / top })),
      notes: 'Scored in the page. No request left the browser.',
    },
  }
}

/**
 * Pick a move for `color`. Resolves with the chosen candidate, how long the
 * provider took, and whatever the provider exposed about its reasoning.
 */
export async function chooseMove({ board, color, ruleSet, provider, key, config = {}, signal }) {
  const candidates = candidateMoves(board, color, ruleSet)
  if (candidates.length === 0) return { move: null, candidates, latencyMs: 0, telemetry: null }

  const position = describePosition(board, color, ruleSet)
  const args = { position, candidates, key, config, signal }

  // A decisive move is not worth a round trip: take the win, block the loss.
  const forced = candidates.find((c) => c.attack === 'five') ?? candidates.find((c) => c.defend === 'five')
  if (forced) {
    return {
      move: forced,
      candidates,
      latencyMs: 0,
      telemetry: {
        provider,
        model: 'forced move',
        ranked: [{ label: forced.label, weight: 1 }],
        notes: forced.attack === 'five' ? 'Winning move played without asking.' : 'Only move that stops five.',
      },
    }
  }

  const run =
    provider === BROWSER_ID
      ? browserMove
      : provider === JEV_ID
        ? jevMove
        : provider === OPENAI_ID
          ? openaiMove
          : localMove

  const result = await run(args)
  return { ...result, candidates }
}

export const colorName = (color) => (color === BLACK ? 'Black' : 'White')

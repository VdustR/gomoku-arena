/**
 * The contract every player satisfies.
 *
 * `arena-extend` described this shape in prose, which meant a new adapter was
 * checked by a person reading a paragraph. It is an interface now, and the
 * engines and the model adapters both satisfy it, so an adapter that returns
 * the wrong shape fails to compile rather than failing on the board.
 *
 * The split that matters: a **model adapter** is handed a shortlist and picks
 * one of it, so it never names a coordinate. An **engine** searches the board
 * itself, so a shortlist would only cap how well it could play. Both come
 * back as one `Choice`.
 */

import type { Board, RuleSetId, Side } from '../rules.ts'
import type { Candidate, PositionSummary } from './heuristic.ts'

/**
 * Where a figure came from, carried with the figure.
 *
 * A search engine counting its own nodes and an agent reporting its own token
 * use are not evidence of the same quality, and this is the whole reason the
 * review can compare anything at all.
 */
export interface RankedMove {
  label: string
  weight: number
}

/** One question a typed decision endpoint answered, and how sure it was. */
export interface Probability {
  label: string
  weight: number
}

/**
 * Whatever a player could say about the move it made.
 *
 * Every field is optional-or-absent on purpose: what a player can account for
 * varies by what the player is, and under `exactOptionalPropertyTypes` a
 * figure nobody reported is a missing key rather than an explicit
 * `undefined`. The review reads that difference.
 */
export interface Telemetry {
  /** Which adapter produced this. Filled in by `chooseMove`, not by the adapter. */
  provider?: string
  model?: string
  /** How sure the player was, where that means anything. Never summed. */
  confidence?: number | null
  ranked?: RankedMove[]
  probabilities?: Probability[]
  /** Free text the player wants kept: what it was weighing. */
  notes?: string
  /** Real token counts, when the endpoint returned them. */
  usage?: Record<string, number>
  [figure: string]: unknown
}

/** A point on the board, as a player names it. */
export interface ChosenMove {
  x: number
  y: number
  label: string
}

/**
 * What an adapter hands back.
 *
 * `move` may be null: a board with no legal move left is not an error, and an
 * adapter that cannot answer says so rather than inventing a point.
 */
export interface Choice {
  move: ChosenMove | null
  latencyMs: number
  telemetry: Telemetry | null
}

/** What `chooseMove` returns: a choice, plus the shortlist it was made from. */
export interface Decision extends Choice {
  candidates: Candidate[]
}

/** Settings a person typed for a relayed provider, or the build's defaults. */
export interface ProviderConfig {
  baseUrl?: string
  model?: string
}

/** What a model adapter is handed. It picks from `candidates` and nothing else. */
export interface ModelRequest {
  position: PositionSummary
  candidates: Candidate[]
  key: string
  config: ProviderConfig
  signal?: AbortSignal | undefined
}

/** A model adapter: given a shortlist, choose one of it. */
export type ModelAdapter = (request: ModelRequest) => Promise<Choice>

/**
 * What an engine returns. Coordinates rather than a shortlist index, because
 * an engine searched the whole board to get here.
 */
export interface EngineResult {
  x: number
  y: number
  point: string
  latencyMs: number
  telemetry: Telemetry
}

/** Knobs for a code-only engine. Each one ignores what it has no use for. */
export interface EngineOptions {
  depth?: number
  width?: number
  budgetMs?: number
  rolloutDepth?: number
  rolloutWidth?: number
}

/** An engine: search the board and name a point, or say there is none. */
export type Engine = (
  board: Board,
  color: Side,
  ruleSet: RuleSetId,
  options?: EngineOptions,
) => EngineResult | null

/** Where an algorithm comes from, or that it has no canonical paper. */
export interface Attribution {
  label: string
  url: string | null
}

export interface EngineEntry {
  id: string
  name: string
  note: string
  tagline: string
  source: Attribution
  run: Engine
}

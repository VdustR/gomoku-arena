/**
 * Build-time configuration.
 *
 * Everything here is baked into the bundle by Vite and is therefore public.
 * Treat it as defaults a deployer wants to change, never as a place for
 * credentials: an API key set through `VITE_*` would ship inside the
 * JavaScript that every visitor downloads.
 *
 * Keys belong either in the browser (typed into Settings, kept in
 * localStorage) or on the server (`GOMOKU_*_KEY`, read by the relay and never
 * sent to the page). See `.env.example`.
 */

import type { RuleSetId } from './rules.ts'

/**
 * A build-time variable, before anything has looked at it.
 *
 * Vite substitutes these at build time and leaves them undefined when they
 * were never set, which is the case each reader below has to get right —
 * `Number('')` is 0, not an absence, and that once clamped every numeric
 * default to the bottom of its range.
 */
export type EnvValue = string | boolean | undefined

/**
 * Vite's own `import.meta.env`, declared here rather than pulled in from
 * `vite/client`: Vite is bundled inside Vite+ rather than declared as a
 * dependency, so there is no package to reference types from. Optional
 * because this module also loads under plain Node, where it is simply absent.
 */
declare global {
  interface ImportMeta {
    readonly env?: Record<string, EnvValue>
  }
}

const env: Record<string, EnvValue> = import.meta.env ?? {}

/*
 * The four readers are exported for their own sake.
 *
 * They decide what every default below actually becomes, and each one has a
 * case that is easy to get wrong — an unset variable is not an empty string,
 * and `Number('')` is 0 rather than an absence. `test/config.test.mjs` used
 * to slice them out of this file's source and re-evaluate them, which tested
 * a copy and broke the moment the file stopped being plain JavaScript.
 */
export const text = (value: EnvValue, fallback: string): string => {
  const trimmed = String(value ?? '').trim()
  return trimmed === '' ? fallback : trimmed
}

export const flag = (value: EnvValue, fallback: boolean): boolean => {
  const trimmed = String(value ?? '')
    .trim()
    .toLowerCase()
  if (trimmed === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(trimmed)
}

interface Range {
  min?: number
  max?: number
}

export const count = (
  value: EnvValue,
  fallback: number,
  { min = 0, max = Number.MAX_SAFE_INTEGER }: Range = {},
): number => {
  const raw = String(value ?? '').trim()
  // An unset variable must fall back, not parse: Number('') is 0, which would
  // silently clamp every default to the bottom of its range.
  if (raw === '') return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

/**
 * Narrow to one of a fixed set, or fall back.
 *
 * Generic over the allowed values, so `defaultRuleSet` comes out as
 * `RuleSetId` rather than `string` — which is what lets it be handed
 * straight to the rules without a second check.
 */
export const oneOf = <T extends string>(value: EnvValue, allowed: readonly T[], fallback: T): T => {
  const trimmed = String(value ?? '')
    .trim()
    .toLowerCase()
  return (allowed as readonly string[]).includes(trimmed) ? (trimmed as T) : fallback
}

/** Which players a fresh game seats. */
export type MatchPreset = 'pvp' | 'pvc' | 'cvc'

export const config = {
  /** Defaults for the two relayed providers. Overridable in Settings. */
  jev: {
    baseUrl: text(env['VITE_JEV_BASE_URL'], 'https://api.typesafe.ai/v1'),
    model: text(env['VITE_JEV_MODEL'], 'jev-latest'),
  },
  openai: {
    baseUrl: text(env['VITE_OPENAI_BASE_URL'], 'https://api.openai.com/v1'),
    model: text(env['VITE_OPENAI_MODEL'], 'gpt-4o-mini'),
  },

  /** How a fresh game starts. */
  defaultRuleSet: oneOf<RuleSetId>(env['VITE_DEFAULT_RULE_SET'], ['free', 'renju'], 'free'),
  defaultMatch: oneOf<MatchPreset>(env['VITE_DEFAULT_MATCH'], ['pvp', 'pvc', 'cvc'], 'pvc'),

  /**
   * The on-device model costs nothing and leaves the machine untouched, so it
   * takes the default AI seat wherever it exists. Set false to make a remote
   * provider the default instead.
   */
  preferBrowserModel: flag(env['VITE_PREFER_BROWSER_MODEL'], true),

  /** How many moves an engine chooses between. More candidates cost tokens. */
  candidateLimit: count(env['VITE_CANDIDATE_LIMIT'], 8, { min: 2, max: 24 }),

  /** A beat before an engine moves, so a fast reply is still readable. */
  moveDelayMs: count(env['VITE_AI_MOVE_DELAY_MS'], 260, { min: 0, max: 5000 }),

  /**
   * Knobs for the code-only engines. Deeper or longer means stronger and
   * slower; these are the values a browser can afford without stalling.
   */
  engines: {
    minimaxDepth: count(env['VITE_MINIMAX_DEPTH'], 4, { min: 2, max: 6 }),
    minimaxWidth: count(env['VITE_MINIMAX_WIDTH'], 10, { min: 4, max: 20 }),
    minimaxBudgetMs: count(env['VITE_MINIMAX_BUDGET_MS'], 2500, { min: 200, max: 20_000 }),
    mctsBudgetMs: count(env['VITE_MCTS_BUDGET_MS'], 1200, { min: 200, max: 20_000 }),
  },

  /** Storage key for the browser-held settings. */
  storageKey: text(env['VITE_STORAGE_KEY'], 'gomoku.settings'),
}

/**
 * Settings live in this browser and nowhere else.
 *
 * Keys ship empty on purpose: there is no bundled credential and no shared
 * default. What you type is written to localStorage under `gomoku.settings`,
 * read back on load, and sent with a request only when a move needs it.
 * Clearing the field, or Forget everything, removes it.
 */

import { config } from './config.ts'
import type { ProviderConfig } from './ai/contract.ts'

/** What this browser holds. Endpoints have defaults; keys never do. */
export interface Settings {
  jevKey: string
  jevBaseUrl: string
  jevModel: string
  openaiKey: string
  openaiBaseUrl: string
  openaiModel: string
}

const STORAGE_KEY = config.storageKey

// Endpoints default to whatever the build was configured with; a key never
// does. See src/lib/config.ts.
const BLANK: Settings = {
  jevKey: '',
  jevBaseUrl: config.jev.baseUrl,
  jevModel: config.jev.model,
  openaiKey: '',
  openaiBaseUrl: config.openai.baseUrl,
  openaiModel: config.openai.model,
}

/** What an earlier version of this page may have left in localStorage. */
interface StoredSettings extends Partial<Settings> {
  /** The provider used to be TypeSafe-only. */
  typesafeKey?: string
}

function load(): Settings {
  if (typeof localStorage === 'undefined') return { ...BLANK }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...BLANK }
    const stored = JSON.parse(raw) as StoredSettings
    // The provider used to be TypeSafe-only; carry an older key across.
    if (stored.typesafeKey && !stored.jevKey) stored.jevKey = stored.typesafeKey
    delete stored.typesafeKey
    return { ...BLANK, ...stored }
  } catch {
    // A corrupt or blocked store is not an error worth showing: start clean.
    return { ...BLANK }
  }
}

export const settings = $state(load())

export function persist(): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...settings }))
  } catch {
    // Private windows and blocked site data both land here. The page keeps
    // working for this session; only the remembering is lost.
  }
}

export function forgetEverything(): void {
  Object.assign(settings, BLANK)
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* nothing to clean up */
  }
}

/** Never render a key; show only enough to recognise which one is stored. */
export function keyFingerprint(value: string | null | undefined): string | null {
  if (!value) return null
  if (value.length <= 8) return `${'•'.repeat(value.length)}`
  return `${value.slice(0, 3)}${'•'.repeat(6)}${value.slice(-4)}`
}

export function keyFor(provider: string): string {
  if (provider === 'jev') return settings.jevKey.trim()
  if (provider === 'openai') return settings.openaiKey.trim()
  return ''
}

export function configFor(provider: string): ProviderConfig {
  if (provider === 'openai') {
    return { baseUrl: settings.openaiBaseUrl.trim(), model: settings.openaiModel.trim() }
  }
  if (provider === 'jev') {
    return { baseUrl: settings.jevBaseUrl.trim(), model: settings.jevModel.trim() }
  }
  return {}
}

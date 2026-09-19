/**
 * What the server can supply, as opposed to what this browser holds.
 *
 * A key set in the environment stays on the server — that is the point of
 * keeping it there — so the page cannot read it and should not try. It used
 * to refuse to play before asking: the gate in `playProvider` looked only at
 * localStorage, so a server configured with `GOMOKU_JEV_KEY` and
 * `GOMOKU_JEV_BASE_URL` still answered "Jev-compatible needs a key" and never
 * called the relay that would have used it. The fallback worked for `curl`
 * and for nothing else.
 *
 * The server answers with whether a key exists and nothing else about it.
 * Asked once, at startup: it cannot change without the server restarting.
 */

import type { ProviderCoverage, RelayCapabilities } from '../../server/relay.ts'

export interface RelayKeys {
  /** False until the first answer arrives, so nothing is claimed early. */
  loaded: boolean
  providers: Record<string, ProviderCoverage>
}

export const relayKeys: RelayKeys = $state({
  loaded: false,
  providers: {},
})

export async function loadRelayKeys(): Promise<RelayKeys> {
  try {
    const response = await fetch('/api/relay')
    if (!response.ok) return relayKeys
    const payload = (await response.json()) as RelayCapabilities
    relayKeys.providers = payload.providers ?? {}
    relayKeys.loaded = true
  } catch {
    // No answer means no server key to fall back on, which is the same
    // position the page was in before. Nothing here is worth an error banner.
  }
  return relayKeys
}

/** Can the server play this provider without a key from the browser? */
export function serverCovers(provider: string): boolean {
  return relayKeys.providers[provider]?.canCover === true
}

/** A server that is half-configured for this provider, and what is missing. */
export function serverProblem(provider: string): string | null {
  return relayKeys.providers[provider]?.problem ?? null
}

/**
 * The relay.
 *
 * Remote inference endpoints refuse browser origins. TypeSafe answers a
 * preflight from every origin tested — including its own console — with
 * `400 Disallowed CORS origin`, so a page with no server cannot reach it.
 * Both relayed providers take the endpoint from the caller, so the same route
 * reaches a hosted service or one running on this machine.
 * This forwards the request and nothing else: the caller's key arrives in
 * `x-provider-key`, is used for exactly one upstream request, and is never
 * logged, cached, or written to disk. The key itself lives in the browser's
 * localStorage; this process holds it only for the duration of one fetch.
 *
 * The same handler backs `npm run dev` (as Vite middleware) and `npm start`
 * (as a plain Node server), so the two behave identically.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

const MAX_BODY_BYTES = 1_000_000

/**
 * Server-side configuration. Unlike `VITE_*`, nothing here reaches the
 * browser, which is why a fallback key may live in one.
 */
const UPSTREAM_TIMEOUT_MS = Number(process.env['GOMOKU_UPSTREAM_TIMEOUT_MS'] ?? 60_000) || 60_000
const ALLOW_INSECURE_HTTP = ['1', 'true', 'yes', 'on'].includes(
  String(process.env['GOMOKU_ALLOW_INSECURE_HTTP'] ?? '')
    .trim()
    .toLowerCase(),
)

/**
 * Both relayed providers are "base URL plus a fixed path". The caller names
 * the base; the path belongs to the wire API.
 *   Jev-compatible: POST <base>/systemone   (TypeSafe, localjev, openjev)
 *   OpenAI-compatible: POST <base>/chat/completions
 */
interface Route {
  /** The provider id the page knows this endpoint by. */
  provider: string
  /** The path this wire API puts after the caller's base URL. */
  suffix: string
  envKey: string
  envBaseUrl: string
}

const ROUTES: Record<string, Route> = {
  '/api/jev': {
    provider: 'jev',
    suffix: '/systemone',
    envKey: 'GOMOKU_JEV_KEY',
    envBaseUrl: 'GOMOKU_JEV_BASE_URL',
  },
  '/api/openai': {
    provider: 'openai',
    suffix: '/chat/completions',
    envKey: 'GOMOKU_OPENAI_KEY',
    envBaseUrl: 'GOMOKU_OPENAI_BASE_URL',
  },
}

/**
 * Which providers this server can cover on a caller's behalf.
 *
 * A key set in the environment stays on the server; that is the whole point
 * of it. So the page cannot see one, and used to refuse to play before
 * asking: its gate looked only at localStorage, and a server configured with
 * `GOMOKU_JEV_KEY` answered "needs a key" without ever calling the relay
 * that would have used it.
 *
 * This says whether a key exists and nothing else about it — not its value,
 * not its length, not its prefix. `problem` names a missing variable, so a
 * half-configured server explains itself instead of failing at the first move
 * with a 500 someone did nothing to deserve.
 */
export interface ProviderCoverage {
  canCover: boolean
  problem: string | null
}

export interface RelayCapabilities {
  providers: Record<string, ProviderCoverage>
}

function relayCapabilities(): RelayCapabilities {
  const providers: Record<string, ProviderCoverage> = {}
  for (const route of Object.values(ROUTES)) {
    const hasKey = Boolean(process.env[route.envKey])
    const hasBaseUrl = Boolean(process.env[route.envBaseUrl])
    providers[route.provider] = {
      canCover: hasKey && hasBaseUrl,
      problem:
        hasKey && !hasBaseUrl
          ? `${route.envKey} is set without ${route.envBaseUrl}. A server key is spent on the caller's behalf, so the server has to pin where it is spent.`
          : null,
    }
  }
  return { providers }
}

interface RelayRequest {
  baseUrl?: unknown
  request?: unknown
}

function readJson(req: IncomingMessage): Promise<RelayRequest> {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > MAX_BODY_BYTES) reject(new Error('request body too large'))
    })
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        reject(new Error('request body was not valid JSON'))
      }
    })
    req.on('error', reject)
  })
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/**
 * Only https, or a loopback http endpoint for someone running a local model.
 * Plain http elsewhere would put the key on the wire in the clear, so it takes
 * a deliberate GOMOKU_ALLOW_INSECURE_HTTP=true to permit it.
 */
function assertRelayableUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`not a valid URL: ${value}`)
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)
  if (url.protocol === 'https:') return url
  if (url.protocol === 'http:' && (loopback || ALLOW_INSECURE_HTTP)) return url
  if (url.protocol === 'http:') {
    throw new Error(
      'endpoint must use https, or http on localhost (set GOMOKU_ALLOW_INSECURE_HTTP=true to override)',
    )
  }
  throw new Error(`unsupported protocol: ${url.protocol}`)
}

interface Forward {
  url: URL
  key: string
  body: unknown
  timeoutMs?: number
}

async function forward(
  res: ServerResponse,
  { url, key, body, timeoutMs = UPSTREAM_TIMEOUT_MS }: Forward,
): Promise<void> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), timeoutMs)
  const startedAt = performance.now()
  try {
    const upstream = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: abort.signal,
    })
    const text = await upstream.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = { error: 'upstream returned a non-JSON response', raw: text.slice(0, 500) }
    }
    send(res, upstream.ok ? 200 : upstream.status, {
      ok: upstream.ok,
      status: upstream.status,
      latencyMs: Math.round(performance.now() - startedAt),
      body: parsed,
    })
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError'
    send(res, aborted ? 504 : 502, {
      ok: false,
      status: aborted ? 504 : 502,
      latencyMs: Math.round(performance.now() - startedAt),
      body: {
        error: aborted
          ? `upstream timed out after ${timeoutMs}ms`
          : error instanceof Error
            ? error.message
            : String(error),
      },
    })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Handle one `/api/*` request. Resolves true when it answered, false when the
 * request was not ours and the caller should keep looking.
 */
export async function handleRelay(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = (req.url ?? '').split('?')[0] ?? ''

  // What the server can supply, asked for once by the page at startup.
  if (path === '/api/relay' && req.method === 'GET') {
    send(res, 200, relayCapabilities())
    return true
  }

  // Claim this handler's own routes first. Rejecting by method before knowing
  // whether the path belongs here would answer every other /api/ route, which
  // is how PATCH /api/match/:id once came back 405.
  const route = Object.entries(ROUTES).find(([prefix]) => path.startsWith(prefix))?.[1]
  if (!route) return false

  if (req.method !== 'POST') {
    send(res, 405, { ok: false, body: { error: 'POST only' } })
    return true
  }

  const sent = req.headers['x-provider-key']
  const callerKey = typeof sent === 'string' && sent.length > 0 ? sent : ''
  const serverKey = process.env[route.envKey] ?? ''
  const key = callerKey || serverKey
  if (!key) {
    send(res, 401, {
      ok: false,
      body: {
        error: `No API key was sent. Add one in Settings, or set ${route.envKey} on the server.`,
      },
    })
    return true
  }

  /*
   * A server key is spent on the caller's behalf, so the caller must not also
   * choose where it is spent: pointing the base URL at a server they control
   * would hand them the key. When the server supplies the key, the server
   * supplies the destination too, and GOMOKU_*_BASE_URL is required for it.
   * A key typed into the page belongs to whoever typed it, so that request
   * keeps naming its own endpoint.
   */
  const usingServerKey = !callerKey
  const pinnedBaseUrl = process.env[route.envBaseUrl] ?? ''
  if (usingServerKey && !pinnedBaseUrl) {
    send(res, 500, {
      ok: false,
      body: {
        error: `${route.envKey} is set without ${route.envBaseUrl}. Set the base URL too, so the server key can only be spent on an endpoint you chose.`,
      },
    })
    return true
  }

  let payload: RelayRequest
  try {
    payload = await readJson(req)
  } catch (error) {
    send(res, 400, { ok: false, body: { error: error instanceof Error ? error.message : String(error) } })
    return true
  }

  let endpoint: URL
  try {
    const requested = usingServerKey ? pinnedBaseUrl : payload.baseUrl
    const base = String(requested ?? '').replace(/\/+$/, '')
    if (!base) throw new Error('no base URL was given for this endpoint')
    endpoint = assertRelayableUrl(`${base}${route.suffix}`)
  } catch (error) {
    send(res, 400, { ok: false, body: { error: error instanceof Error ? error.message : String(error) } })
    return true
  }

  await forward(res, { url: endpoint, key, body: payload.request })
  return true
}

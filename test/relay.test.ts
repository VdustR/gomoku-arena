/**
 * Relay behaviour, exercised against a real server.
 *
 * The case worth protecting: a server key is spent on the caller's behalf, so
 * the caller must not get to choose where it is spent. Otherwise anyone who
 * can reach a server configured with GOMOKU_*_KEY could point the base URL at
 * a host they control and collect the key.
 *
 * Needs no network.
 */

import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { freePort, startServer } from './helpers.ts'
import type { ApiError, TestServer } from './helpers.ts'
import type { RelayCapabilities } from '../server/relay.ts'

/** Which sink a request reached, and the key it arrived carrying. */
interface Echo {
  reachedBy: string
  auth?: string
}

/** The envelope the relay wraps an upstream answer in. */
interface Relayed<T> {
  ok: boolean
  status: number
  latencyMs: number
  body: T
}

type SinkName = 'caller' | 'pinned'

const SERVER_KEY = 'server-secret'

const hits: Record<SinkName, number> = { caller: 0, pinned: 0 }

let callerBase = ''
let pinnedBase = ''
let relayBase = ''
let relay: TestServer | null = null
let sinks: Server[] = []

const sink = (name: SinkName, port: number): Promise<Server> =>
  new Promise((ready) => {
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        hits[name] += 1
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ reachedBy: name, auth: req.headers.authorization }))
      })
    })
    server.listen(port, '127.0.0.1', () => ready(server))
  })

/** Start the app server with the given environment and wait for it to answer. */
async function startRelay(env: Record<string, string>): Promise<TestServer> {
  const started = await startServer(env)
  relayBase = started.base
  return started
}

async function call<T>(route: string, body: unknown, key?: string): Promise<{ status: number; json: T }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (key) headers['x-provider-key'] = key
  const response = await fetch(`${relayBase}${route}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  const text = await response.text()
  try {
    return { status: response.status, json: JSON.parse(text) as T }
  } catch {
    // Surface what actually came back instead of a bare parse error.
    throw new Error(`${route} answered ${response.status} with non-JSON: ${text.slice(0, 120)}`)
  }
}

/** What the server says it can cover, asked of whichever relay is running. */
async function capabilities(): Promise<RelayCapabilities> {
  const response = await fetch(`${relayBase}/api/relay`)
  return (await response.json()) as RelayCapabilities
}

let viaServerKey: Relayed<Echo>
let callerHitsWithServerKey = -1
let capable: RelayCapabilities
let capableJson = ''
let viaCallerKey: Relayed<Echo>
let insecureStatus = 0
let unknownRouteStatus = 0
let missingKeyStatus = 0
let patchedStatus = 0
let patchedBody: ApiError
let unpinnedStatus = 0
let callerHitsAfterUnpinned = -1
let halfway: RelayCapabilities
let bare: RelayCapabilities

beforeAll(async () => {
  const callerPort = await freePort()
  const pinnedPort = await freePort()
  callerBase = `http://127.0.0.1:${callerPort}/v1`
  pinnedBase = `http://127.0.0.1:${pinnedPort}/v1`
  sinks = [await sink('caller', callerPort), await sink('pinned', pinnedPort)]

  relay = await startRelay({ GOMOKU_JEV_KEY: SERVER_KEY, GOMOKU_JEV_BASE_URL: pinnedBase })

  viaServerKey = (await call<Relayed<Echo>>('/api/jev', { baseUrl: callerBase, request: {} })).json
  callerHitsWithServerKey = hits.caller

  /*
   * The page cannot see the environment, which is the point of keeping the key
   * there — so the server has to say whether it has one, or a configured key is
   * unusable from the browser. It says that a key exists and nothing else about
   * it: not the value, not the length, not the prefix.
   */
  capable = await capabilities()
  capableJson = JSON.stringify(capable)

  viaCallerKey = (await call<Relayed<Echo>>('/api/jev', { baseUrl: callerBase, request: {} }, 'caller-key'))
    .json

  insecureStatus = (await call('/api/jev', { baseUrl: 'http://evil.example.com/v1', request: {} }, 'k'))
    .status
  unknownRouteStatus = (await call('/api/nope', { baseUrl: callerBase, request: {} }, 'k')).status
  missingKeyStatus = (await call('/api/openai', { baseUrl: callerBase, request: {} })).status

  /*
   * The relay shares /api/ with the match routes. It once rejected by method
   * before checking whether the path was even its own, which answered every
   * PATCH on the match API with "POST only" and froze the seat picker.
   */
  const patched = await fetch(`${relayBase}/api/match/not-a-real-id`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ black: { kind: 'engine' } }),
  })
  patchedStatus = patched.status
  patchedBody = (await patched.json()) as ApiError

  await relay.stop()
  relay = null

  // A server key without a pinned base URL is a misconfiguration, not a default.
  relay = await startRelay({ GOMOKU_JEV_KEY: SERVER_KEY })
  unpinnedStatus = (await call('/api/jev', { baseUrl: callerBase, request: {} })).status
  callerHitsAfterUnpinned = hits.caller // only the caller-key call above

  /*
   * A half-configured server explains itself up front. Otherwise the page, which
   * now reports what the relay says, would hand someone a 500 at their first
   * move for a variable they never knew about.
   */
  halfway = await capabilities()
  await relay.stop()
  relay = null

  // With nothing configured there is no key and nothing to explain.
  relay = await startRelay({})
  bare = await capabilities()
  await relay.stop()
  relay = null
})

afterAll(async () => {
  await relay?.stop()
  for (const server of sinks) server.close()
})

describe('a server key is spent where the server pinned it', () => {
  it('goes to the endpoint the server pinned', () => {
    expect(viaServerKey.body.reachedBy).toBe('pinned')
  })

  it('forwards the server key, and no other', () => {
    expect(viaServerKey.body.auth).toBe(`Bearer ${SERVER_KEY}`)
  })

  it('never contacts the caller-named endpoint', () => {
    expect(callerHitsWithServerKey).toBe(0)
  })
})

describe('what the server admits to having', () => {
  it('says which providers it can cover', () => {
    expect(capable.providers['jev']?.canCover).toBe(true)
  })

  it('and which it cannot', () => {
    expect(capable.providers['openai']?.canCover).toBe(false)
  })

  it('a configured provider reports no problem', () => {
    expect(capable.providers['jev']?.problem).toBeNull()
  })

  it('publishes nothing of the key itself', () => {
    expect(capableJson).not.toContain(SERVER_KEY)
  })
})

describe('a key typed into the page belongs to whoever typed it', () => {
  it('a caller key may name its own endpoint', () => {
    expect(viaCallerKey.body.reachedBy).toBe('caller')
  })

  it('the server key does not leak to it', () => {
    expect(viaCallerKey.body.auth).toBe('Bearer caller-key')
  })
})

describe('what the relay refuses', () => {
  it('plain http to a non-loopback host is refused', () => {
    expect(insecureStatus).toBe(400)
  })

  it('an unknown route under /api is a JSON 404', () => {
    expect(unknownRouteStatus).toBe(404)
  })

  it('a missing key is a 401', () => {
    expect(missingKeyStatus).toBe(401)
  })
})

describe('the routes the relay does not own', () => {
  it('a PATCH on the match API is not claimed by the relay', () => {
    expect(patchedStatus).toBe(404)
  })

  it('and reaches the match handler', () => {
    expect(patchedBody.error).toBe('no_such_match')
  })
})

describe('a server key without a pinned base URL', () => {
  it('is refused', () => {
    expect(unpinnedStatus).toBe(500)
  })

  it('and the caller-named endpoint is still never contacted', () => {
    expect(callerHitsAfterUnpinned).toBe(1)
  })

  it('cannot be covered', () => {
    expect(halfway.providers['jev']?.canCover).toBe(false)
  })

  it('and the missing variable is named', () => {
    expect(halfway.providers['jev']?.problem).toContain('GOMOKU_JEV_BASE_URL')
  })
})

describe('an unconfigured server', () => {
  it('covers nothing', () => {
    expect(bare.providers['jev']?.canCover).toBe(false)
  })

  it('and reports no problem, because nothing was attempted', () => {
    expect(bare.providers['jev']?.problem).toBeNull()
  })
})

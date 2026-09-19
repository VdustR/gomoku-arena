/**
 * Relay behaviour, exercised against a real server.
 *
 * The case worth protecting: a server key is spent on the caller's behalf, so
 * the caller must not get to choose where it is spent. Otherwise anyone who
 * can reach a server configured with GOMOKU_*_KEY could point the base URL at
 * a host they control and collect the key.
 *
 * Run with `node test/relay.test.mjs`. Needs no network.
 */

import { createServer } from 'node:http'
import { startServer as launch, stop as halt, freePort } from './helpers.mjs'

const CALLER_PORT = await freePort()
const PINNED_PORT = await freePort()
const CALLER_BASE = `http://127.0.0.1:${CALLER_PORT}/v1`
const PINNED_BASE = `http://127.0.0.1:${PINNED_PORT}/v1`
const SERVER_KEY = 'server-secret'
let RELAY_BASE = ''

let pass = 0
let fail = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  ok ? (pass += 1) : (fail += 1)
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}` +
      (ok ? '' : `\n      expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`),
  )
}

const hits = { caller: 0, pinned: 0 }
const sink = (name, port) =>
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
async function startRelay(env) {
  const started = await launch(env)
  RELAY_BASE = started.base
  return started.child
}

const stop = halt

async function call(route, body, key) {
  const headers = { 'content-type': 'application/json' }
  if (key) headers['x-provider-key'] = key
  const response = await fetch(`${RELAY_BASE}${route}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  const text = await response.text()
  try {
    return { status: response.status, json: JSON.parse(text) }
  } catch {
    // Surface what actually came back instead of a bare parse error.
    throw new Error(`${route} answered ${response.status} with non-JSON: ${text.slice(0, 120)}`)
  }
}

const sinks = [await sink('caller', CALLER_PORT), await sink('pinned', PINNED_PORT)]

let relay = await startRelay({ GOMOKU_JEV_KEY: SERVER_KEY, GOMOKU_JEV_BASE_URL: PINNED_BASE })

const viaServerKey = await call('/api/jev', { baseUrl: CALLER_BASE, request: {} })
check('a server key goes to the endpoint the server pinned', viaServerKey.json.body?.reachedBy, 'pinned')
check('the server key is the one forwarded', viaServerKey.json.body?.auth, `Bearer ${SERVER_KEY}`)
check('the caller-named endpoint is never contacted', hits.caller, 0)

const viaCallerKey = await call('/api/jev', { baseUrl: CALLER_BASE, request: {} }, 'caller-key')
check('a caller key may name its own endpoint', viaCallerKey.json.body?.reachedBy, 'caller')
check('the server key does not leak to it', viaCallerKey.json.body?.auth, 'Bearer caller-key')

check(
  'plain http to a non-loopback host is refused',
  (await call('/api/jev', { baseUrl: 'http://evil.example.com/v1', request: {} }, 'k')).status,
  400,
)
check('an unknown route under /api is a JSON 404', (await call('/api/nope', { baseUrl: CALLER_BASE, request: {} }, 'k')).status, 404)
check(
  'a missing key is a 401',
  (await call('/api/openai', { baseUrl: CALLER_BASE, request: {} })).status,
  401,
)

/*
 * The relay shares /api/ with the match routes. It once rejected by method
 * before checking whether the path was even its own, which answered every
 * PATCH on the match API with "POST only" and froze the seat picker.
 */
const patched = await fetch(`${RELAY_BASE}/api/match/not-a-real-id`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ black: { kind: 'engine' } }),
})
const patchedBody = await patched.json()
check('a PATCH on the match API is not claimed by the relay', patched.status, 404)
check('and reaches the match handler', patchedBody.error, 'no_such_match')

await stop(relay)

// A server key without a pinned base URL is a misconfiguration, not a default.
relay = await startRelay({ GOMOKU_JEV_KEY: SERVER_KEY })
const unpinned = await call('/api/jev', { baseUrl: CALLER_BASE, request: {} })
check('a server key without a pinned base URL is refused', unpinned.status, 500)
check('the caller-named endpoint is still never contacted', hits.caller, 1) // only the caller-key call above
await stop(relay)

for (const server of sinks) server.close()

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

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
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RELAY_PORT = 5399
const CALLER_PORT = 8099
const PINNED_PORT = 8100
const CALLER_BASE = `http://127.0.0.1:${CALLER_PORT}/v1`
const PINNED_BASE = `http://127.0.0.1:${PINNED_PORT}/v1`
const SERVER_KEY = 'server-secret'

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

/** Start the relay server with the given environment and wait for it to answer. */
async function startRelay(env) {
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(RELAY_PORT), ...env },
    stdio: 'ignore',
  })
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await fetch(`http://127.0.0.1:${RELAY_PORT}/`)
      return child
    } catch {
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  child.kill()
  throw new Error('relay did not start')
}

const stop = (child) =>
  new Promise((done) => {
    child.once('exit', done)
    child.kill()
  })

async function call(route, body, key) {
  const headers = { 'content-type': 'application/json' }
  if (key) headers['x-provider-key'] = key
  const response = await fetch(`http://127.0.0.1:${RELAY_PORT}${route}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  return { status: response.status, json: await response.json() }
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
check('an unknown route is a 404', (await call('/api/nope', { baseUrl: CALLER_BASE, request: {} }, 'k')).status, 404)
check(
  'a missing key is a 401',
  (await call('/api/openai', { baseUrl: CALLER_BASE, request: {} })).status,
  401,
)

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

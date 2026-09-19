/**
 * The server you start yourself.
 *
 * Holds the matches, answers `/api/*`, serves MCP at `/mcp`, and serves the
 * built page from `dist/`. The same route pipeline backs `npm run dev`, so
 * the two behave identically. Run `npm run build` first, then `npm start`.
 */

import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { handleServerRoutes } from './routes.js'
import { releaseWaiters } from './match.js'

const ROOT = resolve(fileURLToPath(new URL('../dist', import.meta.url)))
const PORT = Number(process.env.PORT ?? 5273) || 5273
const HOST = process.env.HOST ?? '127.0.0.1'

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

/** Resolve a request path inside dist, refusing anything that escapes it. */
function safeJoin(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0])
  const candidate = resolve(join(ROOT, normalize(decoded)))
  if (candidate !== ROOT && !candidate.startsWith(ROOT + '/')) return null
  return candidate
}

async function serveStatic(req, res) {
  const path = req.url === '/' ? '/index.html' : (req.url ?? '/')
  let file = safeJoin(path)
  if (!file) {
    res.statusCode = 403
    res.end('Forbidden')
    return
  }

  try {
    const info = await stat(file)
    if (info.isDirectory()) file = join(file, 'index.html')
  } catch {
    // A single-page app: unknown paths fall back to the entry document.
    file = join(ROOT, 'index.html')
  }

  try {
    const body = await readFile(file)
    res.statusCode = 200
    res.setHeader('content-type', TYPES[extname(file)] ?? 'application/octet-stream')
    res.end(body)
  } catch {
    res.statusCode = 404
    res.setHeader('content-type', 'text/plain; charset=utf-8')
    res.end('Not found. Run `npm run build` first — this server serves dist/.')
  }
}

const server = createServer(async (req, res) => {
  try {
    if (await handleServerRoutes(req, res)) return
    await serveStatic(req, res)
  } catch (error) {
    res.statusCode = 500
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ ok: false, body: { error: String(error?.message ?? error) } }))
  }
})

server.listen(PORT, HOST, () => {
  console.log(`Gomoku Arena on http://gomoku.localhost:${PORT}`)
  console.log(`  page   ${ROOT}`)
  console.log(`  MCP    http://127.0.0.1:${PORT}/mcp`)
})

/*
 * Answer the held calls before going away.
 *
 * An agent in `await_turn` or `play(wait_ms)` is holding an open request. If
 * the process simply exits, that request fails at the transport and the agent
 * is left with an error that is neither "slow opponent" nor "match gone" —
 * the only two cases its instructions cover. Releasing the waiters first
 * turns that into an ordinary answer saying the server is stopping and the
 * match is still there.
 *
 * The pause before closing is for those answers to reach their callers. It is
 * short: a stop should still feel like a stop.
 */
const GRACE_MS = Number(process.env.GOMOKU_SHUTDOWN_GRACE_MS ?? 250) || 250
let stopping = false

async function shutdown() {
  if (stopping) return
  stopping = true
  const released = releaseWaiters('server_stopping')
  if (released > 0) await new Promise((done) => setTimeout(done, GRACE_MS))
  server.closeIdleConnections?.()
  server.close(() => process.exit(0))
  // A keep-alive socket that never goes quiet must not hold the stop open.
  setTimeout(() => process.exit(0), 1500).unref()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

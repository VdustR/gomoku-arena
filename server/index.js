/**
 * The server you start yourself.
 *
 * Serves the built page from `dist/` and answers `/api/*` through the relay,
 * so the production setup matches `npm run dev` exactly. Run `npm run build`
 * first, then `npm start`.
 */

import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { handleRelay } from './relay.js'

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
    if (await handleRelay(req, res)) return
    await serveStatic(req, res)
  } catch (error) {
    res.statusCode = 500
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ ok: false, body: { error: String(error?.message ?? error) } }))
  }
})

server.listen(PORT, HOST, () => {
  console.log(`Gomoku Arena on http://gomoku.localhost:${PORT} (serving ${ROOT})`)
})

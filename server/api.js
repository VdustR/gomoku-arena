/**
 * HTTP surface for the browser.
 *
 * The page is a client of the same match store the MCP tools act on, so a
 * person and an agent can sit at one board. Changes arrive over an event
 * stream rather than by polling.
 */

import {
  MatchError,
  createMatch,
  getMatch,
  listMatches,
  play,
  publicMatch,
  resetMatch,
  undoMove,
  updateMatch,
  watchMatch,
} from './match.js'

const MAX_BODY_BYTES = 256_000

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > MAX_BODY_BYTES) reject(new MatchError('body_too_large', 'Request body too large.'))
    })
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        reject(new MatchError('bad_json', 'Request body was not valid JSON.'))
      }
    })
    req.on('error', reject)
  })
}

function send(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

function fail(res, error) {
  const known = error instanceof MatchError
  const status = known
    ? { no_such_match: 404, illegal_move: 409, not_your_turn: 409, match_over: 409, nothing_to_undo: 409 }[error.code] ?? 400
    : 500
  send(res, status, {
    error: known ? error.code : 'internal_error',
    message: String(error?.message ?? error),
    ...(known ? error.detail : {}),
  })
}

/** Server-sent events for one match. */
function stream(req, res, matchId) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  })
  const send = (state) => res.write(`data: ${JSON.stringify(state)}\n\n`)
  let unwatch
  try {
    unwatch = watchMatch(matchId, send)
  } catch (error) {
    res.write(`event: error\ndata: ${JSON.stringify({ message: String(error.message) })}\n\n`)
    res.end()
    return
  }
  // Proxies drop a silent stream; a comment every 25s keeps it open.
  const beat = setInterval(() => res.write(': keep-alive\n\n'), 25_000)
  req.on('close', () => {
    clearInterval(beat)
    unwatch?.()
  })
}

/**
 * Handle a match request. Resolves true when it answered, false when the
 * path was not ours.
 */
export async function handleApi(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname
  if (!path.startsWith('/api/match')) return false

  try {
    // GET /api/matches/:id/events  — the browser's live feed
    const eventMatch = /^\/api\/match\/([^/]+)\/events$/.exec(path)
    if (eventMatch && req.method === 'GET') {
      stream(req, res, eventMatch[1])
      return true
    }

    if (path === '/api/matches' && req.method === 'GET') {
      send(res, 200, { matches: listMatches() })
      return true
    }

    if (path === '/api/match' && req.method === 'POST') {
      const body = await readJson(req)
      send(res, 201, publicMatch(createMatch(body)))
      return true
    }

    const idMatch = /^\/api\/match\/([^/]+)$/.exec(path)
    if (idMatch && req.method === 'GET') {
      send(res, 200, publicMatch(getMatch(idMatch[1]), { seat: url.searchParams.get('seat') }))
      return true
    }
    if (idMatch && req.method === 'PATCH') {
      send(res, 200, publicMatch(updateMatch(idMatch[1], await readJson(req))))
      return true
    }

    const playMatch = /^\/api\/match\/([^/]+)\/play$/.exec(path)
    if (playMatch && req.method === 'POST') {
      const body = await readJson(req)
      const match = play(playMatch[1], body.seat, body.point, {
        by: body.by ?? null,
        latencyMs: body.latencyMs ?? null,
      })
      send(res, 200, publicMatch(match, { seat: body.seat }))
      return true
    }

    const undoPath = /^\/api\/match\/([^/]+)\/undo$/.exec(path)
    if (undoPath && req.method === 'POST') {
      const body = await readJson(req)
      send(res, 200, publicMatch(undoMove(undoPath[1], { count: body.count })))
      return true
    }

    const resetPath = /^\/api\/match\/([^/]+)\/reset$/.exec(path)
    if (resetPath && req.method === 'POST') {
      send(res, 200, publicMatch(resetMatch(resetPath[1])))
      return true
    }

    send(res, 404, { error: 'no_such_route', message: `No match route for ${req.method} ${path}.` })
    return true
  } catch (error) {
    fail(res, error)
    return true
  }
}

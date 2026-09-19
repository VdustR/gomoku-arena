/**
 * HTTP surface for the browser.
 *
 * The page is a client of the same match store the MCP tools act on, so a
 * person and an agent can sit at one board. Changes arrive over an event
 * stream rather than by polling.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  MatchError,
  createMatch,
  getMatch,
  listMatches,
  pauseMatch,
  play,
  publicMatch,
  resetMatch,
  reviewMatch,
  undoMove,
  updateMatch,
  watchMatch,
} from './match.ts'
import type { MatchErrorCode, PointArg, PublicMatch, SeatConfig, SeatName } from './match.ts'

const MAX_BODY_BYTES = 256_000

/** Whatever JSON the caller sent. Nothing has checked it yet. */
type Body = Record<string, unknown>

function readJson(req: IncomingMessage): Promise<Body> {
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

function send(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/**
 * What each refusal is worth as an HTTP status.
 *
 * `satisfies Record<MatchErrorCode, number>` is what makes this exhaustive: a
 * new code with no status here is a compile error rather than a silent 400
 * that nobody notices until a client branches on the wrong thing.
 */
const STATUS = {
  bad_json: 400,
  bad_point: 400,
  bad_rule_set: 400,
  bad_seat: 400,
  body_too_large: 413,
  illegal_move: 409,
  match_over: 409,
  match_paused: 409,
  no_such_match: 404,
  not_your_turn: 409,
  nothing_to_undo: 409,
} satisfies Record<MatchErrorCode, number>

function fail(res: ServerResponse, error: unknown): void {
  const known = error instanceof MatchError
  const status = known ? STATUS[error.code] : 500
  send(res, status, {
    error: known ? error.code : 'internal_error',
    message: error instanceof Error ? error.message : String(error),
    ...(known ? error.detail : {}),
  })
}

/** Server-sent events for one match. */
function stream(req: IncomingMessage, res: ServerResponse, matchId: string): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  })
  const send = (state: PublicMatch): void => {
    res.write(`data: ${JSON.stringify(state)}\n\n`)
  }
  let unwatch: (() => void) | undefined
  try {
    unwatch = watchMatch(matchId, send)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    res.write(`event: error\ndata: ${JSON.stringify({ message })}\n\n`)
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
/**
 * The id out of a route that matched.
 *
 * Every regex here has exactly one capture group, so the id is always there —
 * but `noUncheckedIndexedAccess` is right that a match array does not promise
 * it, and one place to say so beats ten non-null assertions.
 */
const idOf = (match: RegExpExecArray): string => match[1] ?? ''

/** A seat named by a caller, or null. `play` refuses anything else by name. */
const seatArg = (value: unknown): SeatName | null => (value === 'black' || value === 'white' ? value : null)

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const count = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined)

export async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname
  if (!path.startsWith('/api/match')) return false

  try {
    // GET /api/matches/:id/events  — the browser's live feed
    const eventMatch = /^\/api\/match\/([^/]+)\/events$/.exec(path)
    if (eventMatch && req.method === 'GET') {
      stream(req, res, idOf(eventMatch))
      return true
    }

    if (path === '/api/matches' && req.method === 'GET') {
      send(res, 200, { matches: listMatches() })
      return true
    }

    if (path === '/api/match' && req.method === 'POST') {
      const body = await readJson(req)
      send(
        res,
        201,
        publicMatch(
          createMatch({
            ruleSet: text(body['ruleSet']) ?? undefined,
            black: (body['black'] as SeatConfig | undefined) ?? undefined,
            white: (body['white'] as SeatConfig | undefined) ?? undefined,
          }),
        ),
      )
      return true
    }

    const reviewPath = /^\/api\/match\/([^/]+)\/review$/.exec(path)
    if (reviewPath && req.method === 'GET') {
      send(res, 200, reviewMatch(idOf(reviewPath)))
      return true
    }

    const idMatch = /^\/api\/match\/([^/]+)$/.exec(path)
    if (idMatch && req.method === 'GET') {
      send(res, 200, publicMatch(getMatch(idOf(idMatch)), { seat: seatArg(url.searchParams.get('seat')) }))
      return true
    }
    if (idMatch && req.method === 'PATCH') {
      const patch = await readJson(req)
      send(
        res,
        200,
        publicMatch(
          updateMatch(idOf(idMatch), {
            ruleSet: text(patch['ruleSet']) ?? undefined,
            black: (patch['black'] as SeatConfig | undefined) ?? undefined,
            white: (patch['white'] as SeatConfig | undefined) ?? undefined,
          }),
        ),
      )
      return true
    }

    const playMatch = /^\/api\/match\/([^/]+)\/play$/.exec(path)
    if (playMatch && req.method === 'POST') {
      const body = await readJson(req)
      const match = play(idOf(playMatch), String(body['seat']), body['point'] as PointArg, {
        by: text(body['by']),
        note: text(body['note']),
        latencyMs: count(body['latencyMs']) ?? null,
        metrics: (body['metrics'] as Record<string, unknown> | null) ?? null,
      })
      send(res, 200, publicMatch(match, { seat: seatArg(body['seat']) }))
      return true
    }

    const undoPath = /^\/api\/match\/([^/]+)\/undo$/.exec(path)
    if (undoPath && req.method === 'POST') {
      const body = await readJson(req)
      send(res, 200, publicMatch(undoMove(idOf(undoPath), { count: count(body['count']) ?? 1 })))
      return true
    }

    const pausePath = /^\/api\/match\/([^/]+)\/pause$/.exec(path)
    if (pausePath && req.method === 'POST') {
      const body = await readJson(req)
      send(
        res,
        200,
        publicMatch(
          pauseMatch(idOf(pausePath), {
            paused: body['paused'] !== false,
            by: text(body['by']),
            note: text(body['note']),
          }),
        ),
      )
      return true
    }

    const resetPath = /^\/api\/match\/([^/]+)\/reset$/.exec(path)
    if (resetPath && req.method === 'POST') {
      send(res, 200, publicMatch(resetMatch(idOf(resetPath))))
      return true
    }

    send(res, 404, { error: 'no_such_route', message: `No match route for ${req.method} ${path}.` })
    return true
  } catch (error) {
    fail(res, error)
    return true
  }
}

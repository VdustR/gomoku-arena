/**
 * What happens to a match when nobody is playing it.
 *
 * The store already survives a restart. Resuming is a different thing, and
 * these are the parts of it that have to hold: a finished game is not thrown
 * away to make room for empty boards, and a call left holding when the server
 * stops gets an answer rather than a dropped socket.
 *
 * Needs no network.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectMcp, fetchJson, startServer, stop } from './helpers.ts'
import type { TestServer } from './helpers.ts'
import type { MatchSummary, PublicMatch, SeatName, WaitResult } from '../server/match.ts'

/** What the held call came back with, or the reason it came back with nothing. */
type HeldCall = { ok: true; payload: WaitResult & PublicMatch } | { ok: false; error: string }

let stateDir: string
let store: TestServer | undefined
let resumedServer: TestServer | undefined

let finishedStatus: PublicMatch['status']
let ids: string[]
let finished: string
let played: string
let heldGame: string
let untouched: string
let newest: string
let held: HeldCall
let payload: (WaitResult & PublicMatch) | undefined
let recovered: { status: number; body: PublicMatch }

beforeAll(async () => {
  /*
   * Eviction used to take the least recently updated match of any kind, which
   * meant fifty new boards quietly deleted a finished game someone meant to
   * review — the exact thing New game promises to leave behind.
   */
  stateDir = mkdtempSync(join(tmpdir(), 'gomoku-lifecycle-'))
  store = await startServer({ GOMOKU_MAX_MATCHES: '3', GOMOKU_STATE_DIR: stateDir })
  const base = store.base

  const open = async (): Promise<string> =>
    (
      await fetchJson<PublicMatch>(base, '/api/match', {
        method: 'POST',
        body: JSON.stringify({
          ruleSet: 'free',
          black: { kind: 'agent', label: 'black' },
          white: { kind: 'agent', label: 'white' },
        }),
      })
    ).body.id

  const move = (id: string, seat: SeatName, point: string) =>
    fetchJson<PublicMatch>(base, `/api/match/${id}/play`, {
      method: 'POST',
      body: JSON.stringify({ seat, point }),
    })

  // One finished game: black takes the H file.
  finished = await open()
  const opening: [SeatName, string][] = [
    ['black', 'H8'],
    ['white', 'A1'],
    ['black', 'H9'],
    ['white', 'A2'],
    ['black', 'H10'],
    ['white', 'A3'],
    ['black', 'H11'],
    ['white', 'A4'],
  ]
  for (const [seat, point] of opening) {
    await move(finished, seat, point)
  }
  finishedStatus = (await move(finished, 'black', 'H12')).body.status

  // One unfinished game somebody actually played, and one on hold.
  played = await open()
  await move(played, 'black', 'H8')
  heldGame = await open()
  await fetchJson<PublicMatch>(base, `/api/match/${heldGame}/pause`, {
    method: 'POST',
    body: JSON.stringify({ by: 'someone', note: 'back shortly' }),
  })

  // Two boards nobody plays: the second one takes the unfinished class over
  // its cap, and something has to go.
  untouched = await open()
  newest = await open()

  ids = (await fetchJson<{ matches: MatchSummary[] }>(base, '/api/matches')).body.matches.map((m) => m.id)

  /*
   * A held call is an open HTTP request. When the server stops under it the
   * request fails at the transport, and the caller is left with an error that
   * is neither "slow opponent" nor "match gone" — the only two cases its
   * instructions cover.
   */
  const client = await connectMcp(base, 'waiting-harness')

  // Black played the only stone, so black is not on move: this wait would
  // otherwise sit there for a minute.
  const waiting: Promise<HeldCall> = client
    .callTool({
      name: 'await_turn',
      arguments: { match_id: played, seat: 'black', timeout_ms: 60_000 },
    })
    .then((result): HeldCall => {
      // A tool result comes back as JSON in a text block; anything else here
      // is not an answer to this wait, so it is reported as a failure rather
      // than parsed into one.
      const content: unknown = result.content
      const block = Array.isArray(content)
        ? (content[0] as { type?: string; text?: string } | undefined)
        : undefined
      if (block?.type !== 'text' || typeof block.text !== 'string') {
        throw new Error('the answer carried no text')
      }
      return { ok: true, payload: JSON.parse(block.text) as WaitResult & PublicMatch }
    })
    .catch((error: unknown): HeldCall => ({
      ok: false,
      error: String(error instanceof Error ? error.message : error),
    }))

  // Let the wait reach the server before asking it to stop.
  await new Promise((r) => setTimeout(r, 300))
  const stopping = stop(store.child)
  held = await waiting
  payload = held.ok ? held.payload : undefined

  await stopping
  store = undefined

  // The match itself is intact: a new server on the same store still has it.
  resumedServer = await startServer({ GOMOKU_STATE_DIR: stateDir })
  recovered = await fetchJson<PublicMatch>(resumedServer.base, `/api/match/${played}`)
  await stop(resumedServer.child)
  resumedServer = undefined
})

afterAll(async () => {
  // The sequence above stops both servers itself; these only catch a run that
  // fell over partway and left one behind.
  for (const server of [store, resumedServer]) {
    if (server && server.child.exitCode === null && server.child.signalCode === null) {
      await server.stop()
    }
  }
  if (stateDir) rmSync(stateDir, { recursive: true, force: true })
})

describe('eviction takes the empty board, not the game worth keeping', () => {
  it('starts from a game that is actually finished', () => {
    expect(finishedStatus).toBe('win')
  })

  it('keeps the finished game', () => {
    expect(ids).toContain(finished)
  })

  it('keeps the game on hold', () => {
    expect(ids).toContain(heldGame)
  })

  it('keeps the unfinished game with moves in it', () => {
    expect(ids).toContain(played)
  })

  it('does not delete the board that was just opened by opening it', () => {
    expect(ids).toContain(newest)
  })

  it('drops the board nobody played', () => {
    expect(ids).not.toContain(untouched)
  })

  it('holds the unfinished cap, counting the finished game apart', () => {
    expect(ids.filter((id) => id !== finished)).toHaveLength(3)
  })
})

describe('a call held when the server stops', () => {
  it('is answered rather than dropped', () => {
    // On failure the transport error is the useful thing to read, so it is
    // what the assertion compares against.
    expect(held.ok ? null : held.error).toBeNull()
  })

  it('does not report a timeout', () => {
    expect(payload?.timedOut).toBe(false)
  })

  it('says why the wait ended', () => {
    expect(payload?.interrupted).toBe('server_stopping')
  })

  it('names the match it was waiting on', () => {
    expect(payload?.id).toBe(played)
  })
})

describe('the match outlives the server that was holding the call', () => {
  it('is still there for a new server on the same store', () => {
    expect(recovered.status).toBe(200)
  })

  it('still has its stone', () => {
    expect(recovered.body.board.black).toEqual(['H8'])
  })

  it('is still white to move', () => {
    expect(recovered.body.turn).toBe('white')
  })
})

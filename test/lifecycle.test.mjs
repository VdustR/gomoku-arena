/**
 * What happens to a match when nobody is playing it.
 *
 * The store already survives a restart. Resuming is a different thing, and
 * these are the parts of it that have to hold: a finished game is not thrown
 * away to make room for empty boards, and a call left holding when the server
 * stops gets an answer rather than a dropped socket.
 *
 * Run with `node test/lifecycle.test.mjs`. Needs no network.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer, stop, reporter } from './helpers.mjs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const { check, truthy, done } = reporter()

const json = async (base, path, options) => {
  const response = await fetch(`${base}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...options,
  })
  return { status: response.status, body: await response.json() }
}

/*
 * Eviction used to take the least recently updated match of any kind, which
 * meant fifty new boards quietly deleted a finished game someone meant to
 * review — the exact thing New game promises to leave behind.
 */
const STATE_DIR = mkdtempSync(join(tmpdir(), 'gomoku-lifecycle-'))
const store = await startServer({ GOMOKU_MAX_MATCHES: '3', GOMOKU_STATE_DIR: STATE_DIR })

const open = async () =>
  (
    await json(store.base, '/api/match', {
      method: 'POST',
      body: JSON.stringify({
        ruleSet: 'free',
        black: { kind: 'agent', label: 'black' },
        white: { kind: 'agent', label: 'white' },
      }),
    })
  ).body.id

const move = (id, seat, point) =>
  json(store.base, `/api/match/${id}/play`, {
    method: 'POST',
    body: JSON.stringify({ seat, point }),
  })

// One finished game: black takes the H file.
const finished = await open()
for (const [seat, point] of [
  ['black', 'H8'],
  ['white', 'A1'],
  ['black', 'H9'],
  ['white', 'A2'],
  ['black', 'H10'],
  ['white', 'A3'],
  ['black', 'H11'],
  ['white', 'A4'],
]) {
  await move(finished, seat, point)
}
const won = await move(finished, 'black', 'H12')
check('the game is finished', won.body.status, 'win')

// One unfinished game somebody actually played, and one on hold.
const played = await open()
await move(played, 'black', 'H8')
const heldGame = await open()
await json(store.base, `/api/match/${heldGame}/pause`, {
  method: 'POST',
  body: JSON.stringify({ by: 'someone', note: 'back shortly' }),
})

// Two boards nobody plays: the second one takes the unfinished class over
// its cap, and something has to go.
const untouched = await open()
const newest = await open()

const ids = (await json(store.base, '/api/matches')).body.matches.map((m) => m.id)
truthy('the finished game is still there', ids.includes(finished))
truthy('so is the game on hold', ids.includes(heldGame))
truthy('and the unfinished game with moves in it', ids.includes(played))
truthy('the board that was just opened is not deleted by opening it', ids.includes(newest))
check('the board nobody played is what went', ids.includes(untouched), false)
check('the unfinished cap holds', ids.filter((id) => id !== finished).length, 3)

/*
 * A held call is an open HTTP request. When the server stops under it the
 * request fails at the transport, and the caller is left with an error that
 * is neither "slow opponent" nor "match gone" — the only two cases its
 * instructions cover.
 */
const client = new Client({ name: 'waiting-harness', version: '1.0.0' })
await client.connect(new StreamableHTTPClientTransport(new URL(`${store.base}/mcp`)))

// Black played the only stone, so black is not on move: this wait would
// otherwise sit there for a minute.
const waiting = client
  .callTool({ name: 'await_turn', arguments: { match_id: played, seat: 'black', timeout_ms: 60_000 } })
  .then((result) => ({ ok: true, payload: JSON.parse(result.content[0].text) }))
  .catch((error) => ({ ok: false, error: String(error?.message ?? error) }))

// Let the wait reach the server before asking it to stop.
await new Promise((r) => setTimeout(r, 300))
const stopping = stop(store.child)
const answer = await waiting

truthy('the held call is answered rather than dropped', answer.ok, answer.error)
check('it did not report a timeout', answer.payload?.timedOut, false)
check('it says why the wait ended', answer.payload?.interrupted, 'server_stopping')
truthy('and the match it was waiting on is in the answer', answer.payload?.id === played)

await stopping

// The match itself is intact: a new server on the same store still has it.
const after = await startServer({ GOMOKU_STATE_DIR: STATE_DIR })
const recovered = await json(after.base, `/api/match/${played}`)
check('the match the call was waiting on survived', recovered.status, 200)
check('with its stone', recovered.body.board.black, ['H8'])
check('and it is still white to move', recovered.body.turn, 'white')
await stop(after.child)

rmSync(STATE_DIR, { recursive: true, force: true })
done()

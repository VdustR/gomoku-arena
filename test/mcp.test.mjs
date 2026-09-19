/**
 * Two MCP clients, one board.
 *
 * This is the case the whole design exists for: two separate harnesses, each
 * with its own connection, acting on the same match. It also pins the rules
 * an agent depends on — an illegal move costs no turn, and neither side is
 * shown what the other was thinking.
 *
 * Run with `node test/mcp.test.mjs`. Needs no network.
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 5401
const MCP_URL = new URL(`http://127.0.0.1:${PORT}/mcp`)

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
const truthy = (name, value) => check(name, Boolean(value), true)

async function startServer() {
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  })
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/api/matches`)
      return child
    } catch {
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  child.kill()
  throw new Error('server did not start')
}

async function connect(name) {
  const client = new Client({ name, version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)))
  return client
}

/** Tool results come back as JSON text; give the caller the parsed payload. */
const payloadOf = (result) => JSON.parse(result.content[0].text)
const call = async (client, name, args) => {
  const result = await client.callTool({ name, arguments: args })
  return { isError: Boolean(result.isError), payload: payloadOf(result) }
}

const server = await startServer()
// Two harnesses, two independent connections.
const alice = await connect('harness-black')
const bob = await connect('harness-white')

const tools = (await alice.listTools()).tools.map((t) => t.name).sort()
check('the tool set is what the docs promise', tools, [
  'await_turn',
  'configure_match',
  'get_state',
  'list_matches',
  'new_match',
  'play',
  'reset_match',
])

const opened = await call(alice, 'new_match', {
  rule_set: 'renju',
  black: { kind: 'agent', label: 'harness-black' },
  white: { kind: 'agent', label: 'harness-white' },
  seat: 'black',
})
const matchId = opened.payload.id
truthy('a match opens with an id', matchId)
check('black moves first', opened.payload.turn, 'black')
check('it is black’s move', opened.payload.yourTurn, true)
truthy('the board arrives as an ASCII grid', opened.payload.board.ascii.includes('X = black'))

// The second harness sees the same board through its own connection.
const seenByBob = await call(bob, 'get_state', { match_id: matchId, seat: 'white' })
check('the other harness sees the same match', seenByBob.payload.id, matchId)
check('and knows it is not its move yet', seenByBob.payload.yourTurn, false)

// A free seat is offered no shortlist; that is the point of `free`.
check('a free seat gets no candidate list', seenByBob.payload.candidates, undefined)
const hinted = await call(bob, 'get_state', { match_id: matchId, seat: 'white', candidates: true })
truthy('but may ask for one', hinted.payload.candidates?.length > 0)

// White waits; black plays; white's wait resolves.
const waiting = call(bob, 'await_turn', { match_id: matchId, seat: 'white', timeout_ms: 10_000 })
const played = await call(alice, 'play', { match_id: matchId, seat: 'black', point: 'H8' })
check('black plays a point of its own choosing', played.payload.board.black, ['H8'])
const woken = await waiting
check('the waiting harness is woken, not timed out', woken.payload.timedOut, false)
check('and it is now its move', woken.payload.yourTurn, true)

// The rules that matter to an agent.
const occupied = await call(bob, 'play', { match_id: matchId, seat: 'white', point: 'H8' })
check('an occupied point is refused', occupied.payload.error, 'illegal_move')
const stillWhite = await call(bob, 'get_state', { match_id: matchId, seat: 'white' })
check('and the turn is not consumed', stillWhite.payload.yourTurn, true)

const outOfTurn = await call(alice, 'play', { match_id: matchId, seat: 'black', point: 'J9' })
check('playing out of turn is refused', outOfTurn.payload.error, 'not_your_turn')

const offBoard = await call(bob, 'play', { match_id: matchId, seat: 'white', point: 'Z99' })
check('a point off the board is refused', offBoard.payload.error, 'bad_point')

const good = await call(bob, 'play', { match_id: matchId, seat: 'white', point: 'J9' })
check('a legal move lands', good.payload.board.white, ['J9'])
check('and hands the turn back', good.payload.turn, 'black')

// Renju restricts black. On a fresh board, build a double three and confirm
// it is refused. Black plays F8, G8, H10 and H9; the crossing point H8 then
// opens two threes at once.
const renju = await call(alice, 'new_match', {
  rule_set: 'renju',
  black: { kind: 'agent', label: 'harness-black' },
  white: { kind: 'agent', label: 'harness-white' },
})
const renjuId = renju.payload.id
for (const [seat, point] of [
  ['black', 'F8'],
  ['white', 'A1'],
  ['black', 'G8'],
  ['white', 'A2'],
  ['black', 'H10'],
  ['white', 'A3'],
  ['black', 'H9'],
  ['white', 'A4'],
]) {
  const step = await call(seat === 'black' ? alice : bob, 'play', { match_id: renjuId, seat, point })
  if (step.isError) throw new Error(`setup move ${seat} ${point} failed: ${JSON.stringify(step.payload)}`)
}
const forbidden = await call(alice, 'play', { match_id: renjuId, seat: 'black', point: 'H8' })
check('renju refuses black a double three', forbidden.payload.error, 'illegal_move')
check('naming which restriction', forbidden.payload.reason, 'double-three')
truthy('with an explanation an agent can act on', forbidden.payload.message.includes('double three'))
const afterRefusal = await call(alice, 'get_state', { match_id: renjuId, seat: 'black' })
check('a forbidden move costs no turn either', afterRefusal.payload.yourTurn, true)
const elsewhere = await call(alice, 'play', { match_id: renjuId, seat: 'black', point: 'L12' })
check('and black may simply play elsewhere', elsewhere.isError, false)

// Nothing about the opponent's reasoning is exposed.
const view = await call(bob, 'get_state', { match_id: matchId, seat: 'white' })
const serialized = JSON.stringify(view.payload)
check('no confidence leaks to the opponent', serialized.includes('confidence'), false)
check('no probability distribution leaks either', serialized.includes('probabilities'), false)

// A wait for a turn that is not coming reports a timeout rather than hanging.
// After black's L12 the move is white's, so a wait for black must time out.
const timedOut = await call(alice, 'await_turn', { match_id: renjuId, seat: 'black', timeout_ms: 1000 })
check('a wait that cannot be satisfied times out cleanly', timedOut.payload.timedOut, true)

// Matches are independent.
const both = await call(alice, 'list_matches', {})
check('both matches are listed', both.payload.matches.length, 2)

await alice.close()
await bob.close()
await new Promise((done) => {
  server.once('exit', done)
  server.kill()
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

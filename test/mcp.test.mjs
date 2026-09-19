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

import { startServer as launch, stop as halt } from './helpers.mjs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const { child: serverProcess, base: BASE } = await launch()
const MCP_URL = new URL(`${BASE}/mcp`)

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
  'review',
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

// A refusal names the position it was judged against, so a player that
// decided against a different one can tell the board moved from being wrong.
truthy('a refusal carries the version it was judged against', typeof occupied.payload.version === 'number')
check(
  'and that version is the one the board is on',
  occupied.payload.version,
  stillWhite.payload.version,
)
check('a refusal says how many moves stood on the board', occupied.payload.moves, 1)
check('nothing is claimed to have been rewound', occupied.payload.rewound, undefined)

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

// The review is reachable from the same connection, and keeps what an agent
// said about its moves alongside what the board refused.
const reviewed = await call(alice, 'review', { match_id: renjuId })
check('the review counts the moves played', reviewed.payload.moves.length, 9)
truthy('and measures thinking time', typeof reviewed.payload.moves[0].thinkingMs === 'number')
truthy(
  'the refused double three is attached to the move that followed',
  reviewed.payload.moves.at(-1).rejected.some((r) => r.reason === 'double-three'),
)
check('a reported metric is labelled as such', (await call(alice, 'play', {
  match_id: matchId,
  seat: 'black',
  point: 'M12',
  note: 'testing self-reported metrics',
  metrics: { input_tokens: 42 },
})).isError, false)
const withMetrics = await call(alice, 'review', { match_id: matchId })
check('self-reported numbers are kept, marked reported', withMetrics.payload.moves.at(-1).metrics.source, 'reported')
check('with the value the agent gave', withMetrics.payload.moves.at(-1).metrics.input_tokens, 42)

/*
 * One call per move. The expensive thing for an agent is its own turns, not
 * this server's latency, so play can place the stone, wait for the opponent
 * and hand back the position that resulted.
 */
const cycleMatch = (await call(alice, 'new_match', {
  rule_set: 'free',
  black: { kind: 'agent', label: 'black' },
  white: { kind: 'agent', label: 'white' },
})).payload.id

const cycle = call(alice, 'play', {
  match_id: cycleMatch,
  seat: 'black',
  point: 'H8',
  wait_ms: 10_000,
})
// The opponent answers while that call is still open.
await new Promise((r) => setTimeout(r, 150))
await call(bob, 'play', { match_id: cycleMatch, seat: 'white', point: 'J9' })
const cycled = await cycle

check('one call covers place, wait and read back', cycled.payload.waitedForOpponent, true)
check('it did not simply time out', cycled.payload.timedOut, false)
check('the opponent\u2019s reply is already in the board it returns', cycled.payload.board.white, ['J9'])
check('and it is the caller\u2019s move again', cycled.payload.yourTurn, true)

const noWait = await call(alice, 'play', { match_id: cycleMatch, seat: 'black', point: 'K10' })
check('without wait_ms it returns immediately', noWait.payload.waitedForOpponent, undefined)
check('with the turn handed over', noWait.payload.turn, 'white')

// A wait for a turn that is not coming reports a timeout rather than hanging.
// After black's L12 the move is white's, so a wait for black must time out.
const timedOut = await call(alice, 'await_turn', { match_id: renjuId, seat: 'black', timeout_ms: 1000 })
check('a wait that cannot be satisfied times out cleanly', timedOut.payload.timedOut, true)

// Matches are independent: every one opened in this run is listed.
const listed = await call(alice, 'list_matches', {})
check('every match opened here is listed', listed.payload.matches.length, 3)
check(
  'and each carries its own id',
  new Set(listed.payload.matches.map((m) => m.id)).size,
  3,
)

/*
 * Take back reaches a player who is not on the screen that offers it.
 *
 * The control lives in the browser; the seat it rewinds may be held by an
 * agent that has already decided against the position being removed. The
 * refusal it then gets has to say the board was rewound, or it reads as
 * "you played out of turn" and the agent has no reason to look again.
 */
const rewindMatch = (await call(alice, 'new_match', {
  rule_set: 'free',
  black: { kind: 'human', label: 'someone at the board' },
  white: { kind: 'agent', label: 'harness-white' },
})).payload.id

await call(alice, 'play', { match_id: rewindMatch, seat: 'black', point: 'H8' })
await call(bob, 'play', { match_id: rewindMatch, seat: 'white', point: 'J9' })
const beforeRewind = (await call(bob, 'get_state', { match_id: rewindMatch, seat: 'white' })).payload

// The human presses Take back in the browser, which is an API call, not MCP.
const undone = await fetch(`${BASE}/api/match/${rewindMatch}/undo`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ count: 2 }),
})
check('take back answers the page', undone.status, 200)

// The agent plays the move it had already decided on.
const stale = await call(bob, 'play', { match_id: rewindMatch, seat: 'white', point: 'K10' })
check('the stale move is still refused', stale.payload.error, 'not_your_turn')
check('the refusal names the take-back', stale.payload.rewound.dropped, 2)
check('and the stones it removed', stale.payload.rewound.points, ['H8', 'J9'])
truthy(
  'the message describes what happened rather than blaming the player',
  stale.payload.message.includes('taken back'),
)
truthy(
  'the version has moved past the one the agent decided against',
  stale.payload.version > beforeRewind.version,
)

// The next read says the same thing, so an agent that simply looks again sees it.
const afterRewind = (await call(bob, 'get_state', { match_id: rewindMatch, seat: 'white' })).payload
check('a read after a take-back says the board was rewound', afterRewind.rewound.dropped, 2)
check('and the board is empty again', afterRewind.moves, 0)

/*
 * The claim expires with the next stone. A board that was rewound an hour
 * and six moves ago is not why a move is being refused now.
 */
await call(alice, 'play', { match_id: rewindMatch, seat: 'black', point: 'H8' })
const movedOn = (await call(bob, 'get_state', { match_id: rewindMatch, seat: 'white' })).payload
check('once a stone lands the take-back stops being the explanation', movedOn.rewound, undefined)

await alice.close()
await bob.close()
await halt(serverProcess)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

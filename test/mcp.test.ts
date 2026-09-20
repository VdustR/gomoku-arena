/**
 * Two MCP clients, one board.
 *
 * This is the case the whole design exists for: two separate harnesses, each
 * with its own connection, acting on the same match. It also pins the rules
 * an agent depends on — an illegal move costs no turn, and neither side is
 * shown what the other was thinking.
 *
 * Needs no network. The tests in this file run in order and share the board
 * they build up, because that sequence is the thing being tested.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectMcp, startServer, stop, toolPayload } from './helpers.ts'
import type { TestServer } from './helpers.ts'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'

/**
 * What this suite reads out of a tool result.
 *
 * Deliberately the surface these tests touch rather than the whole MCP
 * schema: a fuller type here would drift from the server without anything
 * noticing, and every field below is one an assertion depends on.
 */
interface Payload {
  id?: string
  turn?: string
  yourTurn?: boolean
  status?: string
  moves?: number
  version?: number
  timedOut?: boolean
  waitedForOpponent?: boolean
  error?: string
  reason?: string
  message?: string
  board?: { ascii?: string; black?: string[]; white?: string[] }
  candidates?: unknown[]
  paused?: { by?: string; note?: string } | null
  rewound?: { dropped?: number; points?: string[] }
  matches?: { id: string; status?: string }[]
  [key: string]: unknown
}

interface ReviewPayload {
  moves: {
    thinkingMs: number
    metrics?: { source?: string; [key: string]: unknown }
    rejected: { reason: string }[]
  }[]
}

let server: TestServer
let alice: Client
let bob: Client
let BASE: string

/** Tool results come back as JSON text; give the caller the parsed payload. */
const call = async <T = Payload>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; payload: T }> => {
  const result = await client.callTool({ name, arguments: args })
  return { isError: Boolean(result.isError), payload: toolPayload<T>(result) }
}

beforeAll(async () => {
  server = await startServer()
  BASE = server.base
  // Two harnesses, two independent connections.
  alice = await connectMcp(BASE, 'harness-black')
  bob = await connectMcp(BASE, 'harness-white')
})

afterAll(async () => {
  await alice?.close()
  await bob?.close()
  if (server) await stop(server.child)
})

const SEATS = {
  black: { kind: 'agent', label: 'harness-black' },
  white: { kind: 'agent', label: 'harness-white' },
}

let matchId: string
let occupiedVersion: number

describe('the surface an agent is promised', () => {
  it('offers exactly the documented tool set', async () => {
    const tools = (await alice.listTools()).tools.map((t) => t.name).sort()
    expect(tools).toEqual([
      'await_turn',
      'configure_match',
      'get_state',
      'list_matches',
      'new_match',
      'pause_match',
      'play',
      'reset_match',
      'review',
    ])
  })

  it('opens a match, on black’s move, with a readable board', async () => {
    const opened = await call(alice, 'new_match', { rule_set: 'renju', ...SEATS, seat: 'black' })
    matchId = opened.payload.id ?? ''
    expect(matchId).toBeTruthy()
    expect(opened.payload.turn).toBe('black')
    expect(opened.payload.yourTurn).toBe(true)
    expect(opened.payload.board?.ascii).toContain('X = black')
  })

  it('shows the same match to the other harness through its own connection', async () => {
    const seen = await call(bob, 'get_state', { match_id: matchId, seat: 'white' })
    expect(seen.payload.id).toBe(matchId)
    expect(seen.payload.yourTurn).toBe(false)
  })

  it('offers a free seat no shortlist, but gives one on request', async () => {
    // A free seat is offered no shortlist; that is the point of `free`.
    const seen = await call(bob, 'get_state', { match_id: matchId, seat: 'white' })
    expect(seen.payload.candidates).toBeUndefined()
    const hinted = await call(bob, 'get_state', { match_id: matchId, seat: 'white', candidates: true })
    expect(hinted.payload.candidates?.length ?? 0).toBeGreaterThan(0)
  })
})

describe('waiting for the other harness', () => {
  it('wakes a waiting seat when the opponent moves, rather than timing it out', async () => {
    const waiting = call(bob, 'await_turn', { match_id: matchId, seat: 'white', timeout_ms: 10_000 })
    const played = await call(alice, 'play', { match_id: matchId, seat: 'black', point: 'H8' })
    expect(played.payload.board?.black).toEqual(['H8'])
    const woken = await waiting
    expect(woken.payload.timedOut).toBe(false)
    expect(woken.payload.yourTurn).toBe(true)
  })
})

describe('the rules that matter to an agent', () => {
  it('refuses an occupied point without consuming the turn', async () => {
    const occupied = await call(bob, 'play', { match_id: matchId, seat: 'white', point: 'H8' })
    expect(occupied.payload.error).toBe('illegal_move')
    const still = await call(bob, 'get_state', { match_id: matchId, seat: 'white' })
    expect(still.payload.yourTurn).toBe(true)

    /*
     * A refusal names the position it was judged against, so a player that
     * decided against a different one can tell the board moved from being
     * wrong.
     */
    expect(typeof occupied.payload.version).toBe('number')
    expect(occupied.payload.version).toBe(still.payload.version)
    expect(occupied.payload.moves).toBe(1)
    expect(occupied.payload.rewound).toBeUndefined()
    occupiedVersion = occupied.payload.version ?? -1
  })

  it('refuses a move played out of turn', async () => {
    const out = await call(alice, 'play', { match_id: matchId, seat: 'black', point: 'J9' })
    expect(out.payload.error).toBe('not_your_turn')
  })

  it('refuses a point that is not on the board', async () => {
    const off = await call(bob, 'play', { match_id: matchId, seat: 'white', point: 'Z99' })
    expect(off.payload.error).toBe('bad_point')
  })

  it('lands a legal move and hands the turn back', async () => {
    const good = await call(bob, 'play', { match_id: matchId, seat: 'white', point: 'J9' })
    expect(good.payload.board?.white).toEqual(['J9'])
    expect(good.payload.turn).toBe('black')
    expect(occupiedVersion).toBeGreaterThanOrEqual(0)
  })
})

let renjuId: string

describe('renju restricts black', () => {
  it('refuses black a double three, names the restriction, and costs no turn', async () => {
    /*
     * On a fresh board, build a double three and confirm it is refused. Black
     * plays F8, G8, H10 and H9; the crossing point H8 then opens two threes
     * at once.
     */
    const renju = await call(alice, 'new_match', { rule_set: 'renju', ...SEATS })
    renjuId = renju.payload.id ?? ''
    const setup: [string, string][] = [
      ['black', 'F8'],
      ['white', 'A1'],
      ['black', 'G8'],
      ['white', 'A2'],
      ['black', 'H10'],
      ['white', 'A3'],
      ['black', 'H9'],
      ['white', 'A4'],
    ]
    for (const [seat, point] of setup) {
      const step = await call(seat === 'black' ? alice : bob, 'play', {
        match_id: renjuId,
        seat,
        point,
      })
      expect(step.isError, `setup move ${seat} ${point}`).toBe(false)
    }

    const forbidden = await call(alice, 'play', { match_id: renjuId, seat: 'black', point: 'H8' })
    expect(forbidden.payload.error).toBe('illegal_move')
    expect(forbidden.payload.reason).toBe('double-three')
    expect(forbidden.payload.message).toContain('double three')

    const after = await call(alice, 'get_state', { match_id: renjuId, seat: 'black' })
    expect(after.payload.yourTurn).toBe(true)
    const elsewhere = await call(alice, 'play', { match_id: renjuId, seat: 'black', point: 'L12' })
    expect(elsewhere.isError).toBe(false)
  })
})

describe('what stays hidden from an opponent', () => {
  it('leaks neither a confidence nor a probability distribution', async () => {
    const view = await call(bob, 'get_state', { match_id: matchId, seat: 'white' })
    const serialized = JSON.stringify(view.payload)
    expect(serialized).not.toContain('confidence')
    expect(serialized).not.toContain('probabilities')
  })
})

describe('the review, from the same connection', () => {
  it('counts the moves, measures thinking time, and keeps the refusal', async () => {
    const reviewed = await call<ReviewPayload>(alice, 'review', { match_id: renjuId })
    expect(reviewed.payload.moves).toHaveLength(9)
    expect(typeof reviewed.payload.moves[0]?.thinkingMs).toBe('number')
    // The refused double three is attached to the move that followed it.
    expect(reviewed.payload.moves.at(-1)?.rejected.some((r) => r.reason === 'double-three')).toBe(true)
  })

  it('keeps a self-reported number, marked as reported', async () => {
    const played = await call(alice, 'play', {
      match_id: matchId,
      seat: 'black',
      point: 'M12',
      note: 'testing self-reported metrics',
      metrics: { input_tokens: 42 },
    })
    expect(played.isError).toBe(false)
    const withMetrics = await call<ReviewPayload>(alice, 'review', { match_id: matchId })
    const last = withMetrics.payload.moves.at(-1)
    expect(last?.metrics?.source).toBe('reported')
    expect(last?.metrics?.['input_tokens']).toBe(42)
  })
})

describe('one call per move', () => {
  /*
   * The expensive thing for an agent is its own turns, not this server's
   * latency, so play can place the stone, wait for the opponent and hand back
   * the position that resulted.
   */
  it('places, waits and reads back in a single call', async () => {
    const cycleMatch = (await call(alice, 'new_match', { rule_set: 'free', ...SEATS })).payload.id ?? ''

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

    expect(cycled.payload.waitedForOpponent).toBe(true)
    expect(cycled.payload.timedOut).toBe(false)
    expect(cycled.payload.board?.white).toEqual(['J9'])
    expect(cycled.payload.yourTurn).toBe(true)

    const noWait = await call(alice, 'play', { match_id: cycleMatch, seat: 'black', point: 'K10' })
    expect(noWait.payload.waitedForOpponent).toBeUndefined()
    expect(noWait.payload.turn).toBe('white')
  })

  it('times out cleanly on a turn that is not coming', async () => {
    // After black's L12 the move is white's, so a wait for black must time out.
    const timedOut = await call(alice, 'await_turn', {
      match_id: renjuId,
      seat: 'black',
      timeout_ms: 1000,
    })
    expect(timedOut.payload.timedOut).toBe(true)
  })
})

describe('a match on hold', () => {
  /*
   * Surviving a restart is not resuming one. A game waiting for a player who
   * is coming back and one abandoned an hour ago have the same move list, so
   * without a hold anyone looking at either sees a live match that is not
   * moving — and a wait on it sits there pretending a turn is coming.
   */
  let heldMatch: string

  it('records who held it and why, and refuses play meanwhile', async () => {
    heldMatch = (await call(alice, 'new_match', { rule_set: 'free', ...SEATS })).payload.id ?? ''
    await call(alice, 'play', { match_id: heldMatch, seat: 'black', point: 'H8' })

    const held = await call(bob, 'pause_match', {
      match_id: heldMatch,
      by: 'harness-white',
      note: 'stepping away, back in ten minutes',
    })
    expect(held.payload.status).toBe('paused')
    expect(held.payload.paused?.by).toBe('harness-white')
    expect(held.payload.paused?.note).toBe('stepping away, back in ten minutes')

    const blocked = await call(bob, 'play', { match_id: heldMatch, seat: 'white', point: 'J9' })
    expect(blocked.payload.error).toBe('match_paused')
    expect(blocked.payload.message).toContain('back in ten minutes')
  })

  it('answers a wait at once instead of pretending a turn is coming', async () => {
    const heldWait = await call(bob, 'await_turn', {
      match_id: heldMatch,
      seat: 'white',
      timeout_ms: 1000,
    })
    expect(heldWait.payload.timedOut).toBe(false)
    expect(heldWait.payload.status).toBe('paused')
  })

  it('shows as held in the listing, and plays again once lifted', async () => {
    const listed = await call(alice, 'list_matches', {})
    expect(listed.payload.matches?.find((m) => m.id === heldMatch)?.status).toBe('paused')

    const resumed = await call(bob, 'pause_match', { match_id: heldMatch, paused: false })
    expect(resumed.payload.status).toBe('playing')
    expect(resumed.payload.paused).toBe(null)
    const after = await call(bob, 'play', { match_id: heldMatch, seat: 'white', point: 'J9' })
    expect(after.isError).toBe(false)
  })

  it('lists every match opened here, each with its own id', async () => {
    // Matches are independent.
    const listed = await call(alice, 'list_matches', {})
    expect(listed.payload.matches).toHaveLength(4)
    expect(new Set(listed.payload.matches?.map((m) => m.id)).size).toBe(4)
  })
})

describe('take back reaches a player who is not on the screen that offers it', () => {
  /*
   * The control lives in the browser; the seat it rewinds may be held by an
   * agent that has already decided against the position being removed. The
   * refusal it then gets has to say the board was rewound, or it reads as
   * "you played out of turn" and the agent has no reason to look again.
   */
  let rewindMatch: string
  let beforeVersion: number

  it('tells the stale agent the board was taken back, not that it was wrong', async () => {
    rewindMatch =
      (
        await call(alice, 'new_match', {
          rule_set: 'free',
          black: { kind: 'human', label: 'someone at the board' },
          white: { kind: 'agent', label: 'harness-white' },
        })
      ).payload.id ?? ''

    await call(alice, 'play', { match_id: rewindMatch, seat: 'black', point: 'H8' })
    await call(bob, 'play', { match_id: rewindMatch, seat: 'white', point: 'J9' })
    beforeVersion =
      (await call(bob, 'get_state', { match_id: rewindMatch, seat: 'white' })).payload.version ?? 0

    // The human presses Take back in the browser, which is an API call, not MCP.
    const undone = await fetch(`${BASE}/api/match/${rewindMatch}/undo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ count: 2 }),
    })
    expect(undone.status).toBe(200)

    // The agent plays the move it had already decided on.
    const stale = await call(bob, 'play', { match_id: rewindMatch, seat: 'white', point: 'K10' })
    expect(stale.payload.error).toBe('not_your_turn')
    expect(stale.payload.rewound?.dropped).toBe(2)
    expect(stale.payload.rewound?.points).toEqual(['H8', 'J9'])
    expect(stale.payload.message).toContain('taken back')
    expect(stale.payload.version).toBeGreaterThan(beforeVersion)
  })

  it('says the same thing on the next read, so looking again is enough', async () => {
    const after = (await call(bob, 'get_state', { match_id: rewindMatch, seat: 'white' })).payload
    expect(after.rewound?.dropped).toBe(2)
    expect(after.moves).toBe(0)
  })

  it('stops explaining itself once a stone lands', async () => {
    /*
     * The claim expires with the next stone. A board that was rewound an hour
     * and six moves ago is not why a move is being refused now.
     */
    await call(alice, 'play', { match_id: rewindMatch, seat: 'black', point: 'H8' })
    const movedOn = (await call(bob, 'get_state', { match_id: rewindMatch, seat: 'white' })).payload
    expect(movedOn.rewound).toBeUndefined()
  })
})

/**
 * A match must survive the server restarting under it.
 *
 * Match state used to live only in memory, so a source edit — which reloads
 * the dev server on its own — ended every game in progress. Two agents
 * mid-match cannot recover from that and have no reason to expect it.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fetchJson, startServer, stop } from './helpers.ts'
import type { ApiError, TestServer } from './helpers.ts'
import type {
  JudgedAgainst,
  MatchSummary,
  PublicMatch,
  Review,
  ReviewMove,
  SeatName,
} from '../server/match.ts'
import type { StoredMatch } from '../server/record.ts'

/** A refusal as the API sends one: the code, and the state it was judged against. */
type Refusal = ApiError & JudgedAgainst

/**
 * The record as it sits on disk.
 *
 * The index signature is what lets this suite ask for the fields that must
 * *not* be there: a board or a winner written alongside the moves is a second
 * copy of the same fact, and `StoredMatch` does not describe one.
 */
type StoredFile = StoredMatch & Record<string, unknown>

let stateDir: string
let running: TestServer[] = []

/** The match every assertion below is about, named once the first run opened it. */
let restoredId: string
let restored: { status: number; body: PublicMatch }
let review: Review
let resumed: { status: number; body: PublicMatch }
let whiteMove: ReviewMove | undefined
let listedIds: string[]
let recordCount: number
let stored: StoredFile
let replayed: PublicMatch
let rewound: { status: number; body: PublicMatch }
let afterRestart: PublicMatch
let refused: Refusal
let survivorIds: string[]
let garbageKept: boolean
let preRefactorKept: boolean

beforeAll(async () => {
  stateDir = mkdtempSync(join(tmpdir(), 'gomoku-state-'))
  const track = async (env: Record<string, string>): Promise<TestServer> => {
    const server = await startServer(env)
    running.push(server)
    return server
  }
  const shutDown = async (server: TestServer): Promise<void> => {
    await stop(server.child)
    running = running.filter((each) => each !== server)
  }

  // First run: open a match and play into it.
  const first = await track({ GOMOKU_STATE_DIR: stateDir })
  const created = await fetchJson<PublicMatch>(first.base, '/api/match', {
    method: 'POST',
    body: JSON.stringify({
      ruleSet: 'renju',
      black: { kind: 'agent', label: 'black' },
      white: { kind: 'agent', label: 'white' },
    }),
  })
  const id = created.body.id

  const opening: [SeatName, string, string | null][] = [
    ['black', 'H8', 'centre'],
    ['white', 'J9', null],
    ['black', 'J8', 'building'],
  ]
  for (const [seat, point, note] of opening) {
    await fetchJson<PublicMatch>(first.base, `/api/match/${id}/play`, {
      method: 'POST',
      body: JSON.stringify({ seat, point, note }),
    })
  }
  await fetchJson<Refusal>(first.base, `/api/match/${id}/play`, {
    method: 'POST',
    body: JSON.stringify({ seat: 'white', point: 'H8' }),
  })
  await shutDown(first)

  // Second run: a different process, the same state directory.
  const second = await track({ GOMOKU_STATE_DIR: stateDir })
  restored = await fetchJson<PublicMatch>(second.base, `/api/match/${id}`)

  review = (await fetchJson<Review>(second.base, `/api/match/${id}/review`)).body

  // The restored match is still playable, not just readable.
  resumed = await fetchJson<PublicMatch>(second.base, `/api/match/${id}/play`, {
    method: 'POST',
    body: JSON.stringify({ seat: 'white', point: 'K10', note: 'after the restart' }),
  })

  /*
   * A refusal is held against the side that made it until that side plays, so
   * it only reaches the record with the move that follows. It changes no stone,
   * which means nothing else would save it — the restart above is what proves
   * it was written.
   */
  const afterResume = (await fetchJson<Review>(second.base, `/api/match/${id}/review`)).body
  whiteMove = afterResume.moves.find((m) => m.point === 'K10')

  listedIds = (await fetchJson<{ matches: MatchSummary[] }>(second.base, '/api/matches')).body.matches.map(
    (m) => m.id,
  )

  /*
   * The stored file holds the move list and nothing derived from it. A board,
   * a winner or a side-to-move written alongside would be a second copy of the
   * same fact, free to disagree with the moves after any change.
   */
  const records = readdirSync(stateDir).filter((name) => name.endsWith('.json'))
  recordCount = records.length
  const [only] = records
  if (!only) throw new Error('no record was written for the match')
  stored = JSON.parse(readFileSync(join(stateDir, only), 'utf8')) as StoredFile

  // A file on its own is enough: a third server sees the same match.
  const third = await track({ GOMOKU_STATE_DIR: stateDir })
  replayed = (await fetchJson<PublicMatch>(third.base, `/api/match/${id}`)).body
  await shutDown(third)

  /*
   * A take-back is not in the move list it leaves behind, so nothing that
   * replays would know it happened. It has to be written, or a player refused
   * after a restart is told only that it played out of turn — the same message
   * it would get for genuinely misbehaving.
   */
  rewound = await fetchJson<PublicMatch>(second.base, `/api/match/${id}/undo`, {
    method: 'POST',
    body: JSON.stringify({ count: 1 }),
  })
  await shutDown(second)

  const fourth = await track({ GOMOKU_STATE_DIR: stateDir })
  afterRestart = (await fetchJson<PublicMatch>(fourth.base, `/api/match/${id}`)).body

  // Black is not on move here; the refusal must explain why rather than accuse.
  refused = (
    await fetchJson<Refusal>(fourth.base, `/api/match/${id}/play`, {
      method: 'POST',
      body: JSON.stringify({ seat: 'black', point: 'C3' }),
    })
  ).body
  await shutDown(fourth)

  /*
   * A file this server cannot read is one match it will not show, not a broken
   * store — and it is left where it is. Four pre-refactor records sat in a
   * working directory this week and loaded without complaint; refusing them is
   * the point, but deleting somebody's game because it could not be parsed is
   * worse than saying so and leaving it alone.
   */
  const garbage = join(stateDir, 'not-json.json')
  const preRefactor = join(stateDir, 'pre-refactor.json')
  writeFileSync(garbage, '{ this is not json')
  writeFileSync(
    preRefactor,
    JSON.stringify({
      id: 'stale-record',
      ruleSet: 'free',
      seats: {
        1: { kind: 'human', label: null, assist: 'free' },
        2: { kind: 'human', label: null, assist: 'free' },
      },
      history: [],
      rejected: { 1: [], 2: [] },
      // The fields that make it stale: all four are replayed, never stored.
      board: Array.from({ length: 225 }, () => 0),
      turn: 1,
      status: 'playing',
      winner: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      version: 0,
    }),
  )

  const fifth = await track({ GOMOKU_STATE_DIR: stateDir })
  survivorIds = (await fetchJson<{ matches: MatchSummary[] }>(fifth.base, '/api/matches')).body.matches.map(
    (m) => m.id,
  )
  garbageKept = existsSync(garbage)
  preRefactorKept = existsSync(preRefactor)
  await shutDown(fifth)

  restoredId = id
})

afterAll(async () => {
  // The sequence stops each server as it finishes with it; this only catches a
  // run that fell over partway and left one behind.
  for (const server of running) await server.stop()
  running = []
  if (stateDir) rmSync(stateDir, { recursive: true, force: true })
})

describe('a match survives the server restarting under it', () => {
  it('is still there after a restart', () => {
    expect(restored.status).toBe(200)
  })

  it('keeps its stones', () => {
    expect(restored.body.board.black).toEqual(['H8', 'J8'])
  })

  it('keeps the opponent’s', () => {
    expect(restored.body.board.white).toEqual(['J9'])
  })

  it('preserves the side to move', () => {
    expect(restored.body.turn).toBe('white')
  })

  it('preserves the rule set', () => {
    expect(restored.body.ruleSet).toBe('renju')
  })

  it('preserves the move count', () => {
    expect(restored.body.moves).toBe(3)
  })

  it('is listed by the restarted server', () => {
    expect(listedIds).toContain(restoredId)
  })
})

describe('the review survives with it', () => {
  it('keeps stated reasons', () => {
    expect(review.moves[0]?.note).toBe('centre')
  })

  it('keeps thinking time', () => {
    expect(review.moves[0]?.thinkingMs).toBeTypeOf('number')
  })
})

describe('the restored match is playable, not just readable', () => {
  it('accepts the next move', () => {
    expect(resumed.status).toBe(200)
  })

  it('lands the stone', () => {
    // Stone lists are in board order, not move order.
    expect([...resumed.body.board.white].sort()).toEqual(['J9', 'K10'])
  })
})

describe('a refusal from before the restart reaches the record', () => {
  it('is attached to the move that followed it', () => {
    expect(whiteMove?.rejected).toHaveLength(1)
  })

  it('carries its reason', () => {
    expect(whiteMove?.rejected[0]?.reason).toBe('occupied')
  })

  it('names the point that was refused', () => {
    expect(whiteMove?.rejected[0]?.point).toBe('H8')
  })
})

describe('the stored file holds the move list and nothing derived from it', () => {
  it('writes one file per match', () => {
    expect(recordCount).toBe(1)
  })

  it('says which shape it is', () => {
    expect(stored.formatVersion).toBe(1)
  })

  it('stores the move list', () => {
    expect(stored.history).toHaveLength(4)
  })

  it('stores the rules', () => {
    expect(stored.ruleSet).toBe('renju')
  })

  it('stores the seats', () => {
    expect(stored.seats).toBeDefined()
  })

  it('does not store the board', () => {
    expect(stored['board']).toBeUndefined()
  })

  it('does not store the side to move', () => {
    expect(stored['turn']).toBeUndefined()
  })

  it('does not store the winner', () => {
    expect(stored['winner']).toBeUndefined()
  })

  it('does not store the status', () => {
    expect(stored['status']).toBeUndefined()
  })
})

describe('a file on its own is enough', () => {
  it('replays the same position on a fresh server', () => {
    expect(replayed.board.white).toHaveLength(2)
  })

  it('replays the same side to move', () => {
    expect(replayed.turn).toBe('black')
  })
})

describe('a take-back is written rather than replayed', () => {
  it('answers the request', () => {
    expect(rewound.status).toBe(200)
  })

  it('says the board was rewound', () => {
    expect(rewound.body.rewound?.dropped).toBe(1)
  })

  it('survives the restart', () => {
    expect(afterRestart.rewound?.dropped).toBe(1)
  })

  it('names the stone it removed', () => {
    expect(afterRestart.rewound?.points).toEqual(['K10'])
  })
})

describe('a move decided against the position before the take-back', () => {
  it('is refused for being out of turn', () => {
    expect(refused.error).toBe('not_your_turn')
  })

  it('still carries the take-back that explains it', () => {
    expect(refused.rewound?.dropped).toBe(1)
  })

  it('carries the version it was judged against', () => {
    expect(refused.version).toBeTypeOf('number')
  })
})

describe('an unreadable file costs one match, not the store', () => {
  it('still loads a readable record beside unreadable ones', () => {
    expect(survivorIds).toContain(restoredId)
  })

  it('does not load the stale record', () => {
    expect(survivorIds).not.toContain('stale-record')
  })

  it('leaves the unreadable file where it is', () => {
    expect(garbageKept).toBe(true)
  })

  it('leaves the stale one too', () => {
    expect(preRefactorKept).toBe(true)
  })
})

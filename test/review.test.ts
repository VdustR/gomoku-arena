/**
 * The review record.
 *
 * What a player can account for differs by what it is, so the record keeps
 * whatever each one produced and says where the number came from. The one
 * figure that is comparable across all of them is thinking time, because the
 * server measures it rather than taking the player's word.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fetchJson, startServer } from './helpers.ts'
import type { ApiError, TestServer } from './helpers.ts'
import type { PublicMatch, Review } from '../server/match.ts'

let server: TestServer
let review: Review
let averaged: Review
let occupied: ApiError
let garbage: ApiError
let missingStatus: number

beforeAll(async () => {
  server = await startServer()
  const base = server.base

  const created = await fetchJson<PublicMatch>(base, '/api/match', {
    method: 'POST',
    body: JSON.stringify({
      ruleSet: 'renju',
      black: { kind: 'agent', label: 'harness' },
      white: { kind: 'engine', label: 'Minimax' },
    }),
  })
  const id = created.body.id
  const play = <T>(seat: string, point: string, extra: Record<string, unknown> = {}) =>
    fetchJson<T>(base, `/api/match/${id}/play`, {
      method: 'POST',
      body: JSON.stringify({ seat, point, ...extra }),
    })

  // A pause the server can measure, so thinking time is not trivially zero.
  await new Promise((r) => setTimeout(r, 60))
  await play('black', 'H8', {
    note: 'centre',
    metrics: { source: 'reported', input_tokens: 120, output_tokens: 8, model: 'some-agent' },
  })
  await play('white', 'J9', {
    by: 'Minimax',
    metrics: { source: 'measured', model: 'minimax depth 4', work: '1,519 nodes' },
  })

  // An illegal attempt is kept, and does not cost the turn.
  occupied = (await play<ApiError>('black', 'H8')).body
  garbage = (await play<ApiError>('black', 'Z99')).body
  await play('black', 'J8', { note: 'after two refusals' })

  review = (await fetchJson<Review>(base, `/api/match/${id}/review`)).body

  // A confidence is not a quantity of work: adding them would be meaningless.
  await play('white', 'K10', { metrics: { source: 'measured', confidence: 0.8 } })
  await play('black', 'L11', { metrics: { source: 'reported', confidence: 0.4, input_tokens: 30 } })
  await play('white', 'M12', { metrics: { source: 'measured', confidence: 0.6 } })
  averaged = (await fetchJson<Review>(base, `/api/match/${id}/review`)).body

  missingStatus = (await fetchJson(base, '/api/match/not-a-real-id/review')).status
})

afterAll(async () => {
  await server?.stop()
})

describe('what the review keeps', () => {
  it('covers every move played, and the rule set', () => {
    expect(review.moves).toHaveLength(3)
    expect(review.ruleSet).toBe('renju')
  })

  it('measures thinking time rather than taking the player’s word', () => {
    expect(review.moves[0]?.thinkingMs).toBeGreaterThanOrEqual(50)
  })

  it('keeps a stated reason', () => {
    expect(review.moves[0]?.note).toBe('centre')
  })
})

describe('refused moves', () => {
  it('refuses an occupied point and an unparseable one', () => {
    expect(occupied.error).toBe('illegal_move')
    expect(garbage.error).toBe('bad_point')
  })

  it('attaches both refusals to the move that followed, with a reason each', () => {
    const third = review.moves[2]
    expect(third?.rejected).toHaveLength(2)
    expect(third?.rejected.map((r) => r.reason)).toEqual(['occupied', 'bad-point'])
  })
})

describe('metrics say where they came from', () => {
  it('labels reported and measured differently', () => {
    expect(review.moves[0]?.metrics?.source).toBe('reported')
    expect(review.moves[1]?.metrics?.source).toBe('measured')
  })

  it('keeps reported token counts and an engine’s own account of its work', () => {
    expect(review.moves[0]?.metrics?.['input_tokens']).toBe(120)
    expect(review.moves[1]?.metrics?.['work']).toBe('1,519 nodes')
  })
})

describe('per-side totals', () => {
  it('counts moves and refusals per side', () => {
    expect([review.sides.black.moves, review.sides.white.moves]).toEqual([2, 1])
    expect(review.sides.black.rejected).toBe(2)
  })

  it('sums and takes a median of thinking time', () => {
    expect(review.sides.black.thinking.totalMs).toBeGreaterThan(0)
    expect(review.sides.black.thinking.medianMs).not.toBeNull()
  })

  it('carries the metric sources into the side total, and sums per key', () => {
    expect(review.sides.black.metrics?.sources).toEqual(['reported'])
    expect(review.sides.black.metrics?.['input_tokens']).toBe(120)
  })

  it('averages a confidence rather than summing it', () => {
    expect(averaged.sides.white.metrics?.['mean confidence']).toBe(0.7)
    expect(averaged.sides.white.metrics?.['confidence']).toBeUndefined()
  })

  it('still adds up token counts', () => {
    expect(averaged.sides.black.metrics?.['input_tokens']).toBe(150)
  })

  it('does not invent a metric a side never reported, but keeps its source', () => {
    expect(review.sides.white.metrics?.['input_tokens']).toBeUndefined()
    expect(review.sides.white.metrics?.sources).toEqual(['measured'])
  })
})

describe('positions', () => {
  it('includes the empty board and one frame per move', () => {
    expect(review.positions).toHaveLength(4)
    expect(review.positions[0]?.every((cell) => cell === 0)).toBe(true)
    expect(review.positions[3]?.filter((cell) => cell !== 0)).toHaveLength(3)
  })
})

it('a review of an unknown match is a 404', () => {
  expect(missingStatus).toBe(404)
})

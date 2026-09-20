/**
 * The stored record has a shape, and a reader must be able to tell whether
 * what it is holding is that shape.
 *
 * The stored shape has already changed once. Records from before the
 * refactor carried `board`, `turn`, `status` and `winner`; four of them sat
 * in a working state directory and loaded without complaint, because the
 * extra fields were simply ignored. That is the failure this suite covers:
 * not a crash, but a reader that cannot tell a current record from a stale
 * one.
 *
 * Needs no server and no network.
 */

import { describe, expect, it } from 'vitest'
import { FORMAT_VERSION, readRecord } from '../server/record.ts'
import type { ReadResult, StoredMatch } from '../server/record.ts'

const NOW = '2026-09-19T12:00:00.000Z'

/** The smallest record the current format accepts. */
const current = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  formatVersion: FORMAT_VERSION,
  id: 'a-match',
  ruleSet: 'free',
  seats: {
    1: { kind: 'human', label: null, assist: 'free' },
    2: { kind: 'agent', label: 'harness', assist: 'free' },
  },
  history: [],
  rejected: { 1: [], 2: [] },
  rewind: null,
  paused: null,
  createdAt: NOW,
  updatedAt: NOW,
  version: 0,
  ...overrides,
})

/**
 * The record behind a read, or nothing.
 *
 * `readRecord` answers with a union, so reaching the record at all means
 * having said out loud that the read succeeded.
 */
const recordOf = (result: ReadResult): StoredMatch | undefined => (result.ok ? result.record : undefined)

/** The stated reason behind a refusal, or nothing. */
const reasonOf = (result: ReadResult): string | undefined => (result.ok ? undefined : result.reason)

const withMoves = readRecord(
  current({
    history: [
      {
        n: 1,
        x: 7,
        y: 7,
        color: 1,
        label: 'H8',
        by: 'you',
        note: 'centre',
        thinkingMs: 1200,
        latencyMs: null,
        metrics: { source: 'reported', input_tokens: 42 },
        rejected: [{ point: 'J9', reason: 'occupied', at: NOW }],
        at: NOW,
      },
    ],
  }),
)

describe('a record in the current shape', () => {
  it('is read', () => {
    expect(readRecord(current()).ok).toBe(true)
  })

  it('is read with its moves, what they said, and what was refused', () => {
    expect(withMoves.ok).toBe(true)
  })

  it('and the reported metric keeps its source', () => {
    expect(recordOf(withMoves)?.history[0]?.metrics?.source).toBe('reported')
  })
})

/*
 * The move list is the only stored fact. The board, the side to move, the
 * winner and every review frame are produced by `replay`, so a record
 * carrying one is not a record this server can honestly claim to understand.
 * A strict schema is what turns that from a convention into a parse failure.
 */
describe('a record carrying something replay would have produced', () => {
  for (const derived of ['board', 'turn', 'status', 'winner', 'winningStones']) {
    it(`is refused for a derived ${derived}, and the reason names it`, () => {
      const refused = readRecord(current({ [derived]: 'anything' }))
      expect(refused.ok).toBe(false)
      expect(reasonOf(refused)).toContain(derived)
    })
  }
})

/*
 * The four files that prompted this: pre-refactor shape, no version stamp.
 * They loaded fine, which was the problem.
 */
const preRefactor = current()
delete preRefactor['formatVersion']
preRefactor['board'] = Array.from({ length: 225 }, () => 0)
preRefactor['turn'] = 1
preRefactor['status'] = 'playing'
preRefactor['winner'] = null

/*
 * A record written by this shape before there was a stamp to write is the
 * same record. The strict parse is what tells the two unstamped cases apart,
 * so the migration is to add the stamp and let it decide.
 */
const unstamped = current()
delete unstamped['formatVersion']
const adopted = readRecord(unstamped)

/*
 * `rewind` and `paused` arrived after the shape settled and before it was
 * stamped. A record from before them is not carrying a take-back or a hold,
 * it predates both — so the migration supplies the absence rather than
 * dropping a real game over a field that did not exist yet.
 */
const beforeRewind = current()
delete beforeRewind['formatVersion']
delete beforeRewind['rewind']
delete beforeRewind['paused']
const early = readRecord(beforeRewind)

describe('records written before there was a version to write', () => {
  it('a pre-refactor record is refused rather than half-read', () => {
    expect(readRecord(preRefactor).ok).toBe(false)
  })

  it('an unstamped record in the current shape is adopted', () => {
    expect(adopted.ok).toBe(true)
  })

  it('and carries the version it was read as', () => {
    expect(recordOf(adopted)?.formatVersion).toBe(FORMAT_VERSION)
  })

  it('a record from before rewind and paused is migrated, not dropped', () => {
    expect(early.ok).toBe(true)
  })

  it('with no take-back, and no hold', () => {
    expect(recordOf(early)?.rewind).toBeNull()
    expect(recordOf(early)?.paused).toBeNull()
  })
})

/*
 * A record from a newer server. Guessing at what its fields mean is how a
 * record gets corrupted by the older half of a rollout.
 */
describe('a record from a newer format', () => {
  const newer = readRecord(current({ formatVersion: FORMAT_VERSION + 1 }))

  it('is refused', () => {
    expect(newer.ok).toBe(false)
  })

  it('and says so rather than blaming the contents', () => {
    expect(reasonOf(newer)).toContain('newer format')
  })
})

describe('things that are not records at all', () => {
  it('a record with no migration path is refused', () => {
    expect(readRecord({ formatVersion: -1 }).ok).toBe(false)
  })

  it('an array is not a record', () => {
    expect(readRecord([]).ok).toBe(false)
  })

  it('null is not a record', () => {
    expect(readRecord(null).ok).toBe(false)
  })

  it('a version that is not a number is refused', () => {
    expect(readRecord(current({ formatVersion: 'one' })).ok).toBe(false)
  })
})

describe('a field of the right name and the wrong type is still wrong', () => {
  it('a rule set this server does not know is refused', () => {
    expect(readRecord(current({ ruleSet: 'tic-tac-toe' })).ok).toBe(false)
  })

  it('a missing move list is refused', () => {
    expect(readRecord(current({ history: undefined })).ok).toBe(false)
  })
})

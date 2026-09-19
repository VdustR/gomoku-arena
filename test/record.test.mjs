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
 * Run with `node test/record.test.mjs`. Needs no server and no network.
 */

import { FORMAT_VERSION, readRecord } from '../server/record.ts'
import { reporter } from './helpers.mjs'

const { check, truthy, done } = reporter()

const NOW = '2026-09-19T12:00:00.000Z'

/** The smallest record the current format accepts. */
const current = (overrides = {}) => ({
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

check('a current record is read', readRecord(current()).ok, true)

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
check('with its moves, what they said, and what was refused', withMoves.ok, true)
check('and the reported metric keeps its source', withMoves.record.history[0].metrics.source, 'reported')

/*
 * The move list is the only stored fact. The board, the side to move, the
 * winner and every review frame are produced by `replay`, so a record
 * carrying one is not a record this server can honestly claim to understand.
 * A strict schema is what turns that from a convention into a parse failure.
 */
for (const derived of ['board', 'turn', 'status', 'winner', 'winningStones']) {
  const refused = readRecord(current({ [derived]: 'anything' }))
  check(`a record carrying a derived ${derived} is refused`, refused.ok, false)
  truthy(`and the reason names it`, refused.reason?.includes(derived), refused.reason)
}

/*
 * The four files that prompted this: pre-refactor shape, no version stamp.
 * They loaded fine, which was the problem.
 */
const preRefactor = current()
delete preRefactor.formatVersion
preRefactor.board = Array.from({ length: 225 }, () => 0)
preRefactor.turn = 1
preRefactor.status = 'playing'
preRefactor.winner = null
const stale = readRecord(preRefactor)
check('a pre-refactor record is refused rather than half-read', stale.ok, false)

/*
 * A record written by this shape before there was a stamp to write is the
 * same record. The strict parse is what tells the two unstamped cases apart,
 * so the migration is to add the stamp and let it decide.
 */
const unstamped = current()
delete unstamped.formatVersion
const adopted = readRecord(unstamped)
check('an unstamped record in the current shape is adopted', adopted.ok, true)
check('and carries the version it was read as', adopted.record.formatVersion, FORMAT_VERSION)

/*
 * `rewind` and `paused` arrived after the shape settled and before it was
 * stamped. A record from before them is not carrying a take-back or a hold,
 * it predates both — so the migration supplies the absence rather than
 * dropping a real game over a field that did not exist yet.
 */
const beforeRewind = current()
delete beforeRewind.formatVersion
delete beforeRewind.rewind
delete beforeRewind.paused
const early = readRecord(beforeRewind)
check('a record from before rewind and paused is migrated, not dropped', early.ok, true)
check('with no take-back', early.record?.rewind, null)
check('and no hold', early.record?.paused, null)

/*
 * A record from a newer server. Guessing at what its fields mean is how a
 * record gets corrupted by the older half of a rollout.
 */
const newer = readRecord(current({ formatVersion: FORMAT_VERSION + 1 }))
check('a record from a newer format is refused', newer.ok, false)
truthy('and says so rather than blaming the contents', newer.reason?.includes('newer format'), newer.reason)

// Things that are not records at all.
check('a record with no migration path is refused', readRecord({ formatVersion: -1 }).ok, false)
check('an array is not a record', readRecord([]).ok, false)
check('null is not a record', readRecord(null).ok, false)
check('a version that is not a number is refused', readRecord(current({ formatVersion: 'one' })).ok, false)

// A field of the right name and the wrong type is still wrong.
check('a rule set this server does not know is refused', readRecord(current({ ruleSet: 'tic-tac-toe' })).ok, false)
check('a missing move list is refused', readRecord(current({ history: undefined })).ok, false)

done()

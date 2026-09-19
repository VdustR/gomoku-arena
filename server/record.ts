/**
 * The shape of a stored match, and what to do with a file that is not it.
 *
 * The stored shape has already changed once. Records written before the
 * refactor carried `board`, `turn`, `status` and `winner`; the current shape
 * stores the move list and replays the rest. Both loaded without complaint,
 * because `restore` parsed JSON and trusted whatever came back — so a reader
 * could not tell a current record from a stale one, and the next change would
 * not have been as forgiving as an ignored field.
 *
 * Two things follow from that, and this module is both of them.
 *
 * `FORMAT_VERSION` is stamped on every record written, so a reader can say
 * which shape it is holding instead of inferring it.
 *
 * The schema is **strict**: a field the schema does not name is a parse
 * failure, not something quietly dropped. That is what makes "the move list
 * is the only stored fact" enforceable rather than conventional — the board,
 * the side to move, the winner and every review frame are produced by
 * `replay`, so writing one alongside the moves now fails to load instead of
 * waiting for a test to notice.
 */

import { z } from 'zod'
import type { RuleSetId, Side } from '../src/lib/rules.ts'

/**
 * Bump this when the stored shape changes, and add a migration for the
 * version you are leaving behind. A record from a version with no migration
 * is skipped and said so, rather than half-read.
 */
export const FORMAT_VERSION = 1

const seat = z.strictObject({
  kind: z.enum(['human', 'agent', 'engine']),
  label: z.string().nullable(),
  assist: z.enum(['free', 'shortlist']),
})

/**
 * What a player could report varies by what the player is, so this stays
 * open on purpose — the bag is the point. `source` is the part that must be
 * there, because a number without its provenance is worth nothing.
 */
const metrics = z
  .looseObject({ source: z.enum(['measured', 'reported']) })
  .nullable()

const refusal = z.strictObject({
  point: z.string(),
  reason: z.string(),
  at: z.string(),
})

const move = z.strictObject({
  n: z.number().int(),
  x: z.number().int(),
  y: z.number().int(),
  color: z.number().int(),
  label: z.string(),
  by: z.string().nullable(),
  note: z.string().nullable(),
  thinkingMs: z.number(),
  latencyMs: z.number().nullable(),
  metrics,
  rejected: z.array(refusal),
  at: z.string(),
})

/**
 * Events that happened *to* a match and leave no trace in the move list they
 * produce, so nothing that replays would know about them.
 */
const rewind = z
  .strictObject({
    at: z.string(),
    dropped: z.number().int(),
    points: z.array(z.string()),
    movesAt: z.number().int(),
  })
  .nullable()

const paused = z
  .strictObject({
    at: z.string(),
    by: z.string().nullable(),
    note: z.string().nullable(),
  })
  .nullable()

/**
 * The stored record.
 *
 * Every field here is something `replay` cannot produce: the rules in force,
 * who held each seat, what each player said, what the board refused, and the
 * two events above. Nothing derived may appear, and `strictObject` is what
 * says so.
 */
/**
 * The stored record, as a type.
 *
 * Derived from the schema rather than written twice, so the shape on disk and
 * the shape in the code cannot drift apart. `server/match.ts` keeps a separate
 * live type: everything here is something `replay` cannot produce.
 */
export const storedMatch = z.strictObject({
  formatVersion: z.literal(FORMAT_VERSION),
  id: z.string(),
  ruleSet: z.enum(['free', 'renju']) satisfies z.ZodType<RuleSetId>,
  seats: z.record(z.string(), seat),
  history: z.array(move),
  rejected: z.record(z.string(), z.array(refusal)),
  rewind,
  paused,
  createdAt: z.string(),
  updatedAt: z.string(),
  version: z.number().int(),
})

export type StoredMatch = z.infer<typeof storedMatch>
export type StoredMove = StoredMatch['history'][number]
export type StoredSeat = StoredMatch['seats'][string]
export type StoredRefusal = StoredMove['rejected'][number]
export type StoredMetrics = StoredMove['metrics']
export type Rewind = NonNullable<StoredMatch['rewind']>
export type Hold = NonNullable<StoredMatch['paused']>

/**
 * Records written before there was a version to write.
 *
 * There is exactly one useful question to ask of them: is this the current
 * shape without its stamp, or the pre-refactor shape with derived fields in
 * it? The strict schema answers that on its own, so the migration is to add
 * the stamp and let the parse decide. Anything carrying a derived field
 * fails, which is the right answer — it is a record this server cannot
 * honestly claim to understand.
 */
const MIGRATIONS: Record<number, (raw: UnknownRecord) => UnknownRecord> = {
  /*
   * Version 0 is everything written before there was a version to write.
   * Two fields arrived after the shape settled and before it was stamped —
   * `rewind` and `paused` — and a record from before them is not carrying a
   * take-back or a hold, it simply predates both. Supplying the absence is a
   * migration; it is not a loosening, because anything carrying a field the
   * schema does not name still fails.
   */
  0: (raw) => ({ rewind: null, paused: null, ...raw, formatVersion: 1 }),
}

/**
 * Read one stored record.
 *
 * Returns `{ ok: true, record }`, or `{ ok: false, reason }` with something
 * worth printing. Nothing here throws and nothing here deletes: a file that
 * cannot be read is one match this server will not show, and silently
 * dropping someone's game is worse than saying you could not read it.
 */
/** What a JSON file hands you before anything has checked it. */
type UnknownRecord = Record<string, unknown>

export type ReadResult = { ok: true; record: StoredMatch } | { ok: false; reason: string }

export function readRecord(raw: unknown): ReadResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'not a match record' }
  }

  const fields = raw as UnknownRecord
  const found = fields['formatVersion'] ?? 0
  if (typeof found !== 'number' || !Number.isInteger(found) || found < 0) {
    return { ok: false, reason: `formatVersion is not a version: ${JSON.stringify(fields['formatVersion'])}` }
  }

  if (found > FORMAT_VERSION) {
    // A newer server wrote this. Guessing at what it means is how a record
    // gets quietly corrupted by the older half of a rollout.
    return {
      ok: false,
      reason: `written by a newer format (${found}); this server reads ${FORMAT_VERSION}`,
    }
  }

  let candidate = fields
  for (let from = found; from < FORMAT_VERSION; from += 1) {
    const migrate = MIGRATIONS[from]
    if (!migrate) return { ok: false, reason: `no migration from format ${from} to ${from + 1}` }
    candidate = migrate(candidate)
  }

  const parsed = storedMatch.safeParse(candidate)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const where = first?.path?.length ? ` at ${first.path.join('.')}` : ''
    return { ok: false, reason: `does not match format ${FORMAT_VERSION}${where}: ${first?.message ?? 'invalid'}` }
  }
  return { ok: true, record: parsed.data }
}

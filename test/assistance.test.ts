/**
 * What the page does for a model seat before the model is asked anything.
 *
 * Measuring a model and fielding a strong player are different jobs, and the
 * default profile is tuned for the second: it narrows every legal point to
 * eight, sorts them by the heuristic's own score, writes what each one does,
 * and plays the move itself when a five is available either way.
 *
 * A seat set up like that can post a whole game without the model having
 * contributed a decision. That is not hypothetical — it happened, undetected,
 * and the record looked identical to a real game either way. These tests pin
 * the difference between the profiles so a seat cannot quietly stop being the
 * player it is labelled as.
 */

import { describe, expect, it } from 'vitest'
import { BLACK, EMPTY, SIZE, WHITE, createBoard, idx } from '../src/lib/rules.ts'
import type { Board, Side, Stone } from '../src/lib/rules.ts'
import { candidateMoves } from '../src/lib/ai/heuristic.ts'
import {
  BROWSER_ID,
  BROWSER_SHORTLISTED_ID,
  BROWSER_UNAIDED_ID,
  JEV_ID,
  JEV_SHORTLISTED_ID,
  JEV_UNAIDED_ID,
  PROVIDERS,
  assistanceFor,
  baseProviderOf,
} from '../src/lib/ai/providers.ts'

const COLUMNS = 'ABCDEFGHJKLMNOP'
type Placement = [label: string, stone: Stone]

const at = (label: string) => ({
  x: COLUMNS.indexOf(label[0] ?? ''),
  y: SIZE - Number(label.slice(1)),
})

const board = (stones: Placement[]): Board => {
  const b = createBoard()
  for (const [label, stone] of stones) {
    const { x, y } = at(label)
    b[idx(x, y)] = stone
  }
  return b
}

/** White to play with J5 winning outright; D5 is blocked, so J5 is the only five. */
const WINNING = board([
  ['E5', WHITE],
  ['F5', WHITE],
  ['G5', WHITE],
  ['H5', WHITE],
  ['D5', BLACK],
  ['E7', BLACK],
  ['F8', BLACK],
  ['G9', BLACK],
])

/** The list a seat with this profile would actually be offered. */
function offered(provider: string, position: Board = WINNING, color: Side = WHITE) {
  const aid = assistanceFor(provider)
  const scored = candidateMoves(position, color, 'free', {
    limit: aid.candidateLimit,
    scope: aid.candidateLimit == null ? 'board' : 'relevant',
  })
  const list = aid.rationale ? scored : scored.map((c) => ({ ...c, rationale: '' }))
  if (!aid.ranked) list.sort((a, b) => a.y - b.y || a.x - b.x)
  return { aid, list }
}

describe('a variant is the same model, differently assisted', () => {
  it.each([
    [JEV_SHORTLISTED_ID, JEV_ID],
    [JEV_UNAIDED_ID, JEV_ID],
    [BROWSER_SHORTLISTED_ID, BROWSER_ID],
    [BROWSER_UNAIDED_ID, BROWSER_ID],
  ])('%s resolves to %s', (variant, base) => {
    expect(baseProviderOf(variant)).toBe(base)
  })

  it('leaves a provider that is not a variant alone', () => {
    expect(baseProviderOf(JEV_ID)).toBe(JEV_ID)
    expect(baseProviderOf('greedy')).toBe('greedy')
  })

  it('registers every variant in the picker, under the model group', () => {
    for (const id of [JEV_SHORTLISTED_ID, JEV_UNAIDED_ID, BROWSER_SHORTLISTED_ID, BROWSER_UNAIDED_ID]) {
      expect(PROVIDERS[id], `${id} is registered`).toBeDefined()
      expect(PROVIDERS[id]?.group).toBe('model')
    }
  })
})

describe('no seat runs with every aid on', () => {
  /*
   * The removed level handed the model eight points, sorted by the
   * heuristic's own score, each annotated with what it did, and played the
   * move itself whenever a five was available. A seat set up that way posted
   * a complete game without the model contributing a decision, and the
   * record could not tell that apart from a real one. It is gone rather than
   * deprecated, so nothing can select it by accident.
   */
  it('does not offer the old full-assist seats in the picker', () => {
    expect(PROVIDERS[JEV_ID]).toBeUndefined()
    expect(PROVIDERS[BROWSER_ID]).toBeUndefined()
  })

  it('keeps those ids working as endpoints for the variants', () => {
    // They are still what says which adapter and which key a variant uses.
    expect(baseProviderOf(JEV_SHORTLISTED_ID)).toBe(JEV_ID)
    expect(baseProviderOf(BROWSER_UNAIDED_ID)).toBe(BROWSER_ID)
  })

  it('never hands any registered seat the heuristic ranking or the shortcut', () => {
    for (const [id, meta] of Object.entries(PROVIDERS)) {
      if (meta.group !== 'model') continue
      const aid = assistanceFor(id)
      expect(aid.forced, `${id} must not play its own move`).toBe(false)
      expect(aid.rationale, `${id} must not be handed the reading`).toBe(false)
      expect(aid.ranked, `${id} must not be handed the ranking`).toBe(false)
    }
  })

  it('falls back to the shortlisted level for an unknown seat', () => {
    const aid = assistanceFor('not-a-provider')
    expect(aid.forced).toBe(false)
    expect(aid.rationale).toBe(false)
  })
})

describe('a shortlisted seat gets the field but reads it itself', () => {
  it.each([JEV_SHORTLISTED_ID, BROWSER_SHORTLISTED_ID])('%s', (id) => {
    const { aid, list } = offered(id)
    expect(aid.candidateLimit).toBeGreaterThan(0)
    expect(list.length).toBe(aid.candidateLimit)

    // No reading of the points, and no move played on the model's behalf.
    expect(aid.rationale).toBe(false)
    expect(aid.forced).toBe(false)
    expect(list.every((c) => c.rationale === '')).toBe(true)

    /*
     * Order is an answer. Offering the heuristic's favourite first tells the
     * model which one that is, so the points arrive in board order and the
     * model does the ranking.
     */
    expect(aid.ranked).toBe(false)
    expect(list[0]?.label).not.toBe('J5')

    // The winning move is still on the list; it is simply not pointed at.
    expect(list.map((c) => c.label)).toContain('J5')
  })
})

describe('an unaided seat gets the board', () => {
  it.each([JEV_UNAIDED_ID, BROWSER_UNAIDED_ID])('%s', (id) => {
    const { aid, list } = offered(id)
    expect(aid.candidateLimit).toBeNull()
    expect(aid.rationale).toBe(false)
    expect(aid.forced).toBe(false)

    // Every empty point on the board, not every point near a stone.
    const empties = [...WINNING].filter((cell) => cell === EMPTY).length
    expect(list).toHaveLength(empties)
    expect(list.map((c) => c.label)).toContain('J5')
  })

  it('is not silently truncated to the two-point floor', () => {
    /*
     * `shortlist.slice(0, Math.max(limit, 2))` returns two points when the
     * limit is null, because `Math.max(null, 2)` is 2. An uncapped seat would
     * have been handed two points and looked inexplicably weak, with nothing
     * in the record to say why.
     */
    const { list } = offered(JEV_UNAIDED_ID)
    expect(list.length).toBeGreaterThan(2)
  })
})

describe('candidateMoves honours the scope it is given', () => {
  it('offers only points near a stone by default', () => {
    const relevant = candidateMoves(WINNING, WHITE, 'free', { limit: null })
    const whole = candidateMoves(WINNING, WHITE, 'free', { limit: null, scope: 'board' })
    expect(relevant.length).toBeLessThan(whole.length)
  })

  it('offers every legal point on an empty board when asked for the board', () => {
    /*
     * The default collapses an empty board to the centre, which is the right
     * answer for a seat that is meant to play well and the wrong one for a
     * seat that is meant to measure a model.
     */
    const empty = createBoard()
    expect(candidateMoves(empty, BLACK, 'free', { limit: null })).toHaveLength(1)
    expect(candidateMoves(empty, BLACK, 'free', { limit: null, scope: 'board' })).toHaveLength(SIZE * SIZE)
  })

  it('never offers a point the board would refuse', () => {
    // Renju forbids black a double three; the whole-board scope must still filter.
    const trap = board([
      ['F8', BLACK],
      ['G8', BLACK],
      ['H10', BLACK],
      ['H9', BLACK],
      ['A1', WHITE],
    ])
    const whole = candidateMoves(trap, BLACK, 'renju', { limit: null, scope: 'board' })
    expect(whole.map((c) => c.label)).not.toContain('H8')
  })
})

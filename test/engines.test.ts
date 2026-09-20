/**
 * The code-only engines.
 *
 * Each is a different classical approach, so the shared expectations are what
 * matter: take a win when there is one, block a loss when there is one, never
 * produce a move the board would refuse, and come back inside their budget.
 */

import { describe, expect, it } from 'vitest'
import { BLACK, WHITE, createBoard, idx, moveLegality, makesFive } from '../src/lib/rules.ts'
import type { Board, RuleSetId, Side, Stone } from '../src/lib/rules.ts'
import { ENGINES } from '../src/lib/ai/engines.ts'
import type { Engine, EngineEntry, EngineOptions, EngineResult } from '../src/lib/ai/contract.ts'

const COLUMNS = 'ABCDEFGHJKLMNOPQRSTUVWXYZ'
type Placement = [x: number, y: number, stone: Stone]

const board = (stones: Placement[]): Board => {
  const b = createBoard()
  for (const [x, y, c] of stones) b[idx(x, y)] = c
  return b
}
const row = (y: number, xs: number[], c: Side): Placement[] => xs.map((x) => [x, y, c])
const pointOf = (label: string) => ({
  x: COLUMNS.indexOf(label[0] ?? ''),
  y: 15 - Number(label.slice(1)),
})

/*
 * An engine may answer "there is no move", so `Engine` returns
 * `EngineResult | null`. Saying so here rather than reaching through the null
 * is the difference between a failing assertion and a TypeError: the old
 * suite read `.point` off the result directly, so an engine that gave up
 * would have crashed the run instead of failing a named check.
 */
function played(result: ReturnType<Engine>, what: string): EngineResult {
  expect(result, `${what} returned no move at all`).not.toBeNull()
  return result as EngineResult
}

// Keep the suite quick: the engines are budget-driven, so shrink the budgets.
const OPTIONS: Record<string, EngineOptions | undefined> = {
  greedy: undefined,
  minimax: { depth: 3, width: 8, budgetMs: 1500 },
  mcts: { budgetMs: 400 },
}

describe.each(Object.values(ENGINES).map((engine) => [engine.name, engine] as const))(
  '%s',
  (_name, engine: EngineEntry) => {
    const opts = OPTIONS[engine.id]

    it('takes the win', () => {
      // Four black stones in a row: the fifth wins outright.
      const move = played(engine.run(board(row(7, [3, 4, 5, 6], BLACK)), BLACK, 'free', opts), 'the win')
      expect(['C8', 'H8']).toContain(move.point)
    })

    it('blocks an immediate loss', () => {
      // White has four in a row; black must block or lose next move.
      const mustBlock = board([...row(7, [3, 4, 5, 6], WHITE), [9, 9, BLACK]])
      const move = played(engine.run(mustBlock, BLACK, 'free', opts), 'the block')
      expect(['C8', 'H8']).toContain(move.point)
    })

    it('never offers a move the board would refuse', () => {
      // Renju forbids black a double three; no engine may offer one.
      const trap = board([...row(7, [5, 6], BLACK), [7, 5, BLACK], [7, 6, BLACK], [0, 0, WHITE]])
      const move = played(engine.run(trap, BLACK, 'renju', opts), 'the renju move')
      const { x, y } = pointOf(move.point)
      expect(moveLegality(trap, x, y, BLACK, 'renju').legal).toBe(true)
    })

    it('reports what it did', () => {
      const move = played(
        engine.run(board(row(7, [3, 4, 5, 6], BLACK)), BLACK, 'free', opts),
        'the reporting move',
      )
      expect(move.telemetry.model).toBeTruthy()
      expect(move.telemetry.ranked?.length ?? 0).toBeGreaterThan(0)
    })
  },
)

/** A whole game between two engines, stopped the moment one is illegal. */
function playOut(
  blackEngine: EngineEntry,
  whiteEngine: EngineEntry,
  ruleSet: RuleSetId = 'free',
): { plies: number; result: string } {
  const b = createBoard()
  let turn: Side = BLACK
  for (let ply = 0; ply < 225; ply += 1) {
    const engine = turn === BLACK ? blackEngine : whiteEngine
    const move = engine.run(b, turn, ruleSet, OPTIONS[engine.id])
    if (!move) return { plies: ply, result: 'draw' }
    const { x, y } = pointOf(move.point)
    const legality = moveLegality(b, x, y, turn, ruleSet)
    if (!legality.legal) return { plies: ply, result: `illegal ${move.point} (${legality.reason})` }
    b[idx(x, y)] = turn
    // Five in a row ends it.
    if (makesFive(b, x, y, turn, { exact: ruleSet === 'renju' && turn === BLACK })) {
      return { plies: ply + 1, result: turn === BLACK ? 'black' : 'white' }
    }
    turn = turn === BLACK ? WHITE : BLACK
  }
  return { plies: 225, result: 'draw' }
}

it('greedy vs minimax plays to a finish with only legal moves', () => {
  const greedy = ENGINES['greedy']
  const minimax = ENGINES['minimax']
  expect(greedy, 'greedy engine is registered').toBeDefined()
  expect(minimax, 'minimax engine is registered').toBeDefined()
  const game = playOut(greedy as EngineEntry, minimax as EngineEntry)
  expect(['black', 'white', 'draw']).toContain(game.result)
})

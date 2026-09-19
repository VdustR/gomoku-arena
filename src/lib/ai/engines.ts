/**
 * Engines that are only code.
 *
 * No model, no key, no network: each of these decides a move by search or by
 * scoring, and each is a different classical approach, so they can be played
 * against one another as well as against a model. They all share the
 * legality rules in `../rules.js`, so none of them can produce a move the
 * board would refuse.
 *
 * Each engine exports the same shape as a provider adapter: it is handed the
 * position and returns a chosen point plus what it can say about the choice.
 *
 * ## Where these come from
 *
 * No code here is copied from anywhere. Each engine is written from the
 * published description of its method, so the references below are the source
 * of the algorithm, not of the implementation — worth stating plainly, because
 * claiming an adaptation that did not happen would be as wrong as omitting a
 * real one.
 *
 * - Alpha-beta pruning: D. E. Knuth and R. W. Moore, "An analysis of
 *   alpha-beta pruning", Artificial Intelligence 6(4), 1975, 293-326.
 *   https://www.sciencedirect.com/science/article/abs/pii/0004370275900193
 *
 * - Monte Carlo tree search: R. Coulom, "Efficient Selectivity and Backup
 *   Operators in Monte-Carlo Tree Search", Computers and Games 2006, 72-83.
 *   https://link.springer.com/chapter/10.1007/978-3-540-75538-8_7
 *
 * - UCT, the selection rule used here: L. Kocsis and C. Szepesvari, "Bandit
 *   Based Monte-Carlo Planning", ECML 2006, LNCS 4212, 282-293.
 *   https://link.springer.com/chapter/10.1007/11871842_29
 *
 * - Greedy threat scoring has no canonical paper. It is the standard shape
 *   heuristic every gomoku program carries in some form, written here against
 *   this project's own rules module.
 *
 * Context for all three: free-style gomoku on 15x15 is a first-player win,
 * proved by L. V. Allis, "Searching for Solutions in Games and Artificial
 * Intelligence", PhD thesis, University of Limburg, 1994. That is why renju
 * restricts black, and why an engine playing white here is not starting level.
 * https://cris.maastrichtuniversity.nl/en/publications/searching-for-solutions-in-games-and-artificial-intelligence
 */

import { EMPTY, SIZE, idx, moveLegality, coordLabel, other } from '../rules.ts'
import type { Board, RuleSetId, Side, Stone } from '../rules.ts'
import { SHAPE_SCORES, bestShape, relevantPoints } from './heuristic.ts'
import type { EngineEntry, EngineResult } from './contract.ts'

/** One point the search is considering, with what it is worth right now. */
interface ScoredPoint {
  x: number
  y: number
  value: number
}

/**
 * How good the position at (x, y) is for `color`, counting both what it
 * builds and what it denies. Defence is discounted slightly so a win is
 * never traded for a block.
 */
function pointValue(board: Board, x: number, y: number, color: Side): number {
  const attack = SHAPE_SCORES[bestShape(board, x, y, color, SIZE)]
  const defend = SHAPE_SCORES[bestShape(board, x, y, other(color), SIZE)]
  return attack + defend * 0.85
}

/** Legal moves worth searching, strongest first. */
function orderedMoves(board: Board, color: Side, ruleSet: RuleSetId, limit?: number): ScoredPoint[] {
  const scored: ScoredPoint[] = []
  for (const [x, y] of relevantPoints(board, SIZE)) {
    if (!moveLegality(board, x, y, color, ruleSet).legal) continue
    scored.push({ x, y, value: pointValue(board, x, y, color) })
  }
  scored.sort((a, b) => b.value - a.value)
  return limit ? scored.slice(0, limit) : scored
}

const WIN_VALUE = SHAPE_SCORES.five

/** Whole-board score from `color`'s point of view. */
function evaluate(board: Board, color: Side): number {
  let score = 0
  for (let i = 0; i < board.length; i += 1) {
    const cell = board[i] as Stone | undefined
    if (cell === undefined || cell === EMPTY) continue
    const x = i % SIZE
    const y = Math.floor(i / SIZE)
    // Score the shape each stone sits in by temporarily lifting it.
    board[i] = EMPTY
    const shape = SHAPE_SCORES[bestShape(board, x, y, cell, SIZE)]
    board[i] = cell
    score += cell === color ? shape : -shape
  }
  return score
}

/** Would playing here complete five for `color`? */
const wins = (board: Board, x: number, y: number, color: Side): boolean =>
  SHAPE_SCORES[bestShape(board, x, y, color, SIZE)] >= WIN_VALUE

/* ------------------------------------------------------------------ */
/* 1. Greedy threat scoring                                            */
/* ------------------------------------------------------------------ */

/**
 * One ply. Score every relevant point for what it builds and what it blocks,
 * and take the best. Instant, and surprisingly hard to beat casually, but it
 * cannot see a trap one move deeper.
 */
export function greedyMove(board: Board, color: Side, ruleSet: RuleSetId): EngineResult | null {
  const started = performance.now()
  const moves = orderedMoves(board, color, ruleSet)
  const top = moves[0]
  if (!top) return null
  const best = Math.max(top.value, 1)
  return {
    x: top.x,
    y: top.y,
    point: coordLabel(top.x, top.y),
    latencyMs: Math.max(1, Math.round(performance.now() - started)),
    telemetry: {
      model: 'greedy threat scoring',
      ranked: moves.slice(0, 6).map((m) => ({ label: coordLabel(m.x, m.y), weight: m.value / best })),
      notes: `Scored ${moves.length} points one ply deep.`,
    },
  }
}

/* ------------------------------------------------------------------ */
/* 2. Minimax with alpha-beta pruning                                  */
/* ------------------------------------------------------------------ */

/**
 * Depth-limited minimax over a narrowed move list, with alpha-beta pruning
 * and move ordering by the same scoring the greedy engine uses. Good move
 * ordering is what makes the pruning pay: the best move is usually examined
 * first, so most of the tree is never opened — Knuth and Moore (1975) is where
 * that result is proved, and where the bound on how much it saves comes from.
 */
export function minimaxMove(
  board: Board,
  color: Side,
  ruleSet: RuleSetId,
  { depth = 4, width = 10, budgetMs = 2500 }: { depth?: number; width?: number; budgetMs?: number } = {},
): EngineResult | null {
  const started = performance.now()
  let nodes = 0
  let cutoffs = 0
  let outOfTime = false

  const search = (position: Board, turn: Side, remaining: number, alpha: number, beta: number): number => {
    nodes += 1
    if (performance.now() - started > budgetMs) {
      outOfTime = true
      return evaluate(position, color)
    }
    if (remaining === 0) return evaluate(position, color)

    const moves = orderedMoves(position, turn, ruleSet, width)
    if (moves.length === 0) return evaluate(position, color)

    const maximizing = turn === color
    let best = maximizing ? -Infinity : Infinity

    for (const move of moves) {
      // An immediate win ends the line; depth beyond it is wasted.
      if (wins(position, move.x, move.y, turn)) {
        const terminal = maximizing ? WIN_VALUE + remaining : -(WIN_VALUE + remaining)
        if (maximizing) alpha = Math.max(alpha, terminal)
        else beta = Math.min(beta, terminal)
        best = maximizing ? Math.max(best, terminal) : Math.min(best, terminal)
        if (beta <= alpha) {
          cutoffs += 1
          return best
        }
        continue
      }

      position[idx(move.x, move.y)] = turn
      const value = search(position, other(turn), remaining - 1, alpha, beta)
      position[idx(move.x, move.y)] = EMPTY

      if (maximizing) {
        best = Math.max(best, value)
        alpha = Math.max(alpha, value)
      } else {
        best = Math.min(best, value)
        beta = Math.min(beta, value)
      }
      if (beta <= alpha) {
        cutoffs += 1
        break
      }
    }
    return best
  }

  const root = orderedMoves(board, color, ruleSet, width)
  if (root.length === 0) return null

  const position = board.slice()
  const scored: (ScoredPoint & { score: number })[] = []
  for (const move of root) {
    if (wins(position, move.x, move.y, color)) {
      scored.push({ ...move, score: WIN_VALUE * 2 })
      break
    }
    position[idx(move.x, move.y)] = color
    scored.push({ ...move, score: search(position, other(color), depth - 1, -Infinity, Infinity) })
    position[idx(move.x, move.y)] = EMPTY
  }

  scored.sort((a, b) => b.score - a.score)
  const top = scored[0]
  if (!top) return null
  const span = Math.abs(top.score - (scored.at(-1)?.score ?? top.score)) || 1

  return {
    x: top.x,
    y: top.y,
    point: coordLabel(top.x, top.y),
    latencyMs: Math.max(1, Math.round(performance.now() - started)),
    telemetry: {
      model: `minimax depth ${depth}, width ${width}`,
      ranked: scored.slice(0, 6).map((m) => ({
        label: coordLabel(m.x, m.y),
        weight: Math.max(0, 1 - (top.score - m.score) / span),
      })),
      notes:
        `${nodes.toLocaleString()} nodes, ${cutoffs} alpha-beta cutoffs` +
        (outOfTime ? `, stopped at the ${budgetMs}ms budget.` : '.'),
    },
  }
}

/* ------------------------------------------------------------------ */
/* 3. Monte Carlo tree search (UCT)                                    */
/* ------------------------------------------------------------------ */

const UCT_C = Math.SQRT2

/**
 * UCT with heuristic-guided playouts, run against a time budget.
 *
 * The tree policy is UCT as Kocsis and Szepesvari (2006) define it: pick the
 * child maximising win rate plus C * sqrt(ln(N) / n). The surrounding
 * search-then-average structure is Coulom's (2006) MCTS.
 *
 * Uniformly random playouts are close to worthless on a 15x15 board — a
 * random game almost never reaches five in a row — so rollouts pick from the
 * top few scored points instead. That keeps the statistics meaningful within
 * a budget a browser can afford.
 */
export function mctsMove(
  board: Board,
  color: Side,
  ruleSet: RuleSetId,
  {
    budgetMs = 1200,
    rolloutDepth = 24,
    rolloutWidth = 4,
  }: { budgetMs?: number; rolloutDepth?: number; rolloutWidth?: number } = {},
): EngineResult | null {
  const started = performance.now()
  const rootMoves = orderedMoves(board, color, ruleSet, 12)
  if (rootMoves.length === 0) return null

  /*
   * Forced tactics are decided before sampling starts. Guided playouts still
   * miss a mandatory block often enough to lose games on it, because a single
   * rollout that happens to block reads as a win and the statistics never
   * settle in the few hundred playouts a browser can afford. Taking the win
   * and answering the opponent's five directly is what MCTS implementations
   * in tactical games normally do, and it costs nothing.
   */
  const forced = (point: ScoredPoint, why: string): EngineResult => ({
    x: point.x,
    y: point.y,
    point: coordLabel(point.x, point.y),
    latencyMs: Math.max(1, Math.round(performance.now() - started)),
    telemetry: {
      model: 'MCTS (UCT)',
      ranked: [{ label: coordLabel(point.x, point.y), weight: 1 }],
      notes: why,
    },
  })

  for (const move of rootMoves) {
    if (wins(board, move.x, move.y, color)) return forced(move, 'Winning move taken without sampling.')
  }
  for (const move of rootMoves) {
    if (wins(board, move.x, move.y, other(color))) {
      return forced(move, 'Only move that stops five; taken without sampling.')
    }
  }

  const nodes = rootMoves.map((move) => ({ ...move, visits: 0, wins: 0 }))
  let simulations = 0

  const rollout = (position: Board, start: Side): number => {
    let turn = start
    for (let ply = 0; ply < rolloutDepth; ply += 1) {
      const moves = orderedMoves(position, turn, ruleSet, rolloutWidth)
      const pick = moves[Math.floor(Math.random() * moves.length)]
      if (!pick) return 0.5
      if (wins(position, pick.x, pick.y, turn)) return turn === color ? 1 : 0
      position[idx(pick.x, pick.y)] = turn
      turn = other(turn)
    }
    // Nobody won inside the horizon: fall back to the static score.
    const score = evaluate(position, color)
    return score > 0 ? 0.6 : score < 0 ? 0.4 : 0.5
  }

  while (performance.now() - started < budgetMs) {
    let chosen = nodes[0]
    if (!chosen) break
    let bestUct = -Infinity
    for (const node of nodes) {
      const uct =
        node.visits === 0
          ? Infinity
          : node.wins / node.visits + UCT_C * Math.sqrt(Math.log(simulations + 1) / node.visits)
      if (uct > bestUct) {
        bestUct = uct
        chosen = node
      }
    }

    const position = board.slice()
    position[idx(chosen.x, chosen.y)] = color
    chosen.wins += rollout(position, other(color))
    chosen.visits += 1
    simulations += 1
  }

  const ranked = [...nodes].sort((a, b) => b.visits - a.visits || b.wins - a.wins)
  const top = ranked[0]
  if (!top) return null
  return {
    x: top.x,
    y: top.y,
    point: coordLabel(top.x, top.y),
    latencyMs: Math.max(1, Math.round(performance.now() - started)),
    telemetry: {
      model: 'MCTS (UCT)',
      confidence: top.visits ? top.wins / top.visits : null,
      ranked: ranked.slice(0, 6).map((node) => ({
        label: coordLabel(node.x, node.y),
        weight: simulations ? node.visits / simulations : 0,
      })),
      notes: `${simulations.toLocaleString()} playouts over ${nodes.length} root moves in ${budgetMs}ms.`,
    },
  }
}

/** The engines, in the order a reader should meet them. */
export const ENGINES: Record<string, EngineEntry> = {
  greedy: {
    id: 'greedy',
    name: 'Greedy scoring',
    note: 'one ply',
    tagline: 'One ply of threat scoring. Instant, and blind to anything deeper.',
    source: { label: 'Standard shape heuristic, no canonical paper', url: null },
    run: greedyMove,
  },
  minimax: {
    id: 'minimax',
    name: 'Minimax (alpha-beta)',
    note: 'searches ahead',
    tagline: 'Depth-limited search with pruning and move ordering.',
    source: {
      label: 'Knuth & Moore 1975, An analysis of alpha-beta pruning',
      url: 'https://www.sciencedirect.com/science/article/abs/pii/0004370275900193',
    },
    run: minimaxMove,
  },
  mcts: {
    id: 'mcts',
    name: 'MCTS (UCT)',
    note: 'samples playouts',
    tagline: 'Guided random playouts, budgeted by time rather than depth.',
    source: {
      label: 'Kocsis & Szepesvári 2006, Bandit Based Monte-Carlo Planning',
      url: 'https://link.springer.com/chapter/10.1007/11871842_29',
    },
    run: mctsMove,
  },
}

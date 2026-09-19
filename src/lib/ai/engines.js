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
 */

import { BLACK, WHITE, EMPTY, SIZE, idx, moveLegality, coordLabel } from '../rules.js'
import { SHAPE_SCORES, bestShape, relevantPoints } from './heuristic.js'

const other = (color) => (color === BLACK ? WHITE : BLACK)

/**
 * How good the position at (x, y) is for `color`, counting both what it
 * builds and what it denies. Defence is discounted slightly so a win is
 * never traded for a block.
 */
function pointValue(board, x, y, color) {
  const attack = SHAPE_SCORES[bestShape(board, x, y, color, SIZE)]
  const defend = SHAPE_SCORES[bestShape(board, x, y, other(color), SIZE)]
  return attack + defend * 0.85
}

/** Legal moves worth searching, strongest first. */
function orderedMoves(board, color, ruleSet, limit) {
  const scored = []
  for (const [x, y] of relevantPoints(board, SIZE)) {
    if (!moveLegality(board, x, y, color, ruleSet).legal) continue
    scored.push({ x, y, value: pointValue(board, x, y, color) })
  }
  scored.sort((a, b) => b.value - a.value)
  return limit ? scored.slice(0, limit) : scored
}

const WIN_VALUE = SHAPE_SCORES.five

/** Whole-board score from `color`'s point of view. */
function evaluate(board, color) {
  let score = 0
  for (let i = 0; i < board.length; i += 1) {
    const cell = board[i]
    if (cell === EMPTY) continue
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
const wins = (board, x, y, color) => SHAPE_SCORES[bestShape(board, x, y, color, SIZE)] >= WIN_VALUE

/* ------------------------------------------------------------------ */
/* 1. Greedy threat scoring                                            */
/* ------------------------------------------------------------------ */

/**
 * One ply. Score every relevant point for what it builds and what it blocks,
 * and take the best. Instant, and surprisingly hard to beat casually, but it
 * cannot see a trap one move deeper.
 */
export function greedyMove(board, color, ruleSet) {
  const started = performance.now()
  const moves = orderedMoves(board, color, ruleSet)
  if (moves.length === 0) return null
  const top = moves[0]
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
 * first, so most of the tree is never opened.
 */
export function minimaxMove(board, color, ruleSet, { depth = 4, width = 10, budgetMs = 2500 } = {}) {
  const started = performance.now()
  let nodes = 0
  let cutoffs = 0
  let outOfTime = false

  const search = (position, turn, remaining, alpha, beta) => {
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
  const scored = []
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
  const span = Math.abs(scored[0].score - scored.at(-1).score) || 1

  return {
    x: top.x,
    y: top.y,
    point: coordLabel(top.x, top.y),
    latencyMs: Math.max(1, Math.round(performance.now() - started)),
    telemetry: {
      model: `minimax depth ${depth}, width ${width}`,
      ranked: scored.slice(0, 6).map((m) => ({
        label: coordLabel(m.x, m.y),
        weight: Math.max(0, 1 - (scored[0].score - m.score) / span),
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
 * Uniformly random playouts are close to worthless on a 15x15 board — a
 * random game almost never reaches five in a row — so rollouts pick from the
 * top few scored points instead. That keeps the statistics meaningful within
 * a budget a browser can afford.
 */
export function mctsMove(board, color, ruleSet, { budgetMs = 1200, rolloutDepth = 24, rolloutWidth = 4 } = {}) {
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
  const forced = (point, why) => ({
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

  const rollout = (position, turn) => {
    for (let ply = 0; ply < rolloutDepth; ply += 1) {
      const moves = orderedMoves(position, turn, ruleSet, rolloutWidth)
      if (moves.length === 0) return 0.5
      const pick = moves[Math.floor(Math.random() * moves.length)]
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
export const ENGINES = {
  greedy: {
    id: 'greedy',
    name: 'Greedy scoring',
    note: 'one ply',
    tagline: 'One ply of threat scoring. Instant, and blind to anything deeper.',
    run: greedyMove,
  },
  minimax: {
    id: 'minimax',
    name: 'Minimax (alpha-beta)',
    note: 'searches ahead',
    tagline: 'Depth-limited search with pruning and move ordering.',
    run: minimaxMove,
  },
  mcts: {
    id: 'mcts',
    name: 'MCTS (UCT)',
    note: 'samples playouts',
    tagline: 'Guided random playouts, budgeted by time rather than depth.',
    run: mctsMove,
  },
}

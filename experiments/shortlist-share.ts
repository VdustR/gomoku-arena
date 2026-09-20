/**
 * How much of a shortlisted seat's play was the shortlist?
 *
 *   node experiments/shortlist-share.ts <tag=match-id> [tag=match-id ...]
 *
 * A seat the page drives never chooses from the board. It is handed at most
 * `candidateLimit` points, already ranked by the heuristic and already
 * annotated with why each one is worth playing, and it answers with one of
 * them. So "which move did the model pick" and "which move did the heuristic
 * put first" are different questions, and the gap between them is the part of
 * the play that belongs to the model.
 *
 * This replays each match from its move list, recomputes the shortlist the
 * seat would have been offered at every turn, and reports where the move it
 * actually played sat in that ranking. Nothing here calls a model or a
 * network: the board, the rules and the heuristic are the project's own.
 *
 * A seat played by an agent over MCP gets no shortlist at all, so it is
 * counted separately and its rank is undefined rather than zero.
 */

import { EMPTY, BLACK, WHITE, SIZE, idx } from '../src/lib/rules.ts'
import { candidateMoves } from '../src/lib/ai/heuristic.ts'
import type { Review } from '../server/match.ts'

const BASE = process.env['GOMOKU_URL'] ?? 'http://localhost:5273'
const COLS = 'ABCDEFGHJKLMNOP'

const pairs = process.argv.slice(2)
if (pairs.length === 0) {
  console.error('usage: node experiments/shortlist-share.ts <tag=match-id> ...')
  process.exit(2)
}

const pointOf = (label: string): { x: number; y: number } => {
  const x = COLS.indexOf(label[0] ?? '')
  const y = SIZE - Number(label.slice(1))
  return { x, y }
}

interface Tally {
  /** The label the record carries, which is null for a move nobody signed. */
  name: string | null
  shortlisted: number
  top1: number
  top3: number
  offBoard: number
  ranks: number[]
  agentMoves: number
  forced: number
}

/** Per-player tallies, keyed by the label the record carries. */
const players = new Map<string | null, Tally>()
const seed = (name: string | null): Tally => {
  const found = players.get(name)
  if (found) return found
  const tally: Tally = {
    name,
    shortlisted: 0,
    top1: 0,
    top3: 0,
    offBoard: 0,
    ranks: [],
    agentMoves: 0,
    forced: 0,
  }
  players.set(name, tally)
  return tally
}

for (const pair of pairs) {
  const [tag = pair, id] = pair.split('=')
  const review = (await (await fetch(`${BASE}/api/match/${id}/review`)).json()) as Review
  const ruleSet = review.ruleSet
  const kindOf = {
    black: review.sides.black.player.kind,
    white: review.sides.white.player.kind,
  }

  const board = new Uint8Array(SIZE * SIZE).fill(EMPTY)
  for (const move of review.moves) {
    const color = move.seat === 'black' ? BLACK : WHITE
    const { x, y } = pointOf(move.point)
    const p = seed(move.by)

    const forced = move.metrics?.['model'] === 'forced move'
    if (kindOf[move.seat] === 'agent') {
      p.agentMoves++
    } else if (forced) {
      /*
       * A forced move never reached the model, and the shortlist builder
       * pushes a decisive or urgent point to the front regardless of score,
       * so counting these would credit the model with a rank it did not
       * choose and flatter the heuristic at the same time.
       */
      p.forced++
    } else {
      const shortlist = candidateMoves(board, color, ruleSet)
      const rank = shortlist.findIndex((c) => c.label === move.point)
      if (rank === -1) {
        // The seat played something the heuristic never offered. For an
        // in-page seat this should not happen; it is counted rather than
        // dropped so the total still adds up.
        p.offBoard++
      } else {
        p.shortlisted++
        p.ranks.push(rank)
        if (rank === 0) p.top1++
        if (rank < 3) p.top3++
      }
    }
    board[idx(x, y)] = color
  }
  console.error(`replayed ${tag} (${review.moves.length} moves)`)
}

const pct = (n: number, d: number): string => (d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%`)
const mean = (xs: number[]): string | null =>
  xs.length === 0 ? null : (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2)

console.log('\nShortlisted seats — where the played move sat in the heuristic ranking\n')
console.log('| Player | Model-chosen moves | Took rank 1 | Took top 3 | Mean rank | Forced (excluded) |')
console.log('| --- | --- | --- | --- | --- | --- |')
for (const p of players.values()) {
  if (p.shortlisted === 0) continue
  console.log(
    `| ${p.name} | ${p.shortlisted} | ${p.top1} (${pct(p.top1, p.shortlisted)}) | ` +
      `${p.top3} (${pct(p.top3, p.shortlisted)}) | ${mean(p.ranks)} | ${p.forced} |`,
  )
}

const agents = [...players.values()].filter((p) => p.agentMoves > 0)
if (agents.length) {
  console.log('\nSeats played over MCP — offered no shortlist, so no rank applies\n')
  for (const p of agents) console.log(`  ${p.name}: ${p.agentMoves} moves chosen from the whole board`)
}
const strays = [...players.values()].filter((p) => p.offBoard > 0)
for (const p of strays) console.log(`\n  note: ${p.name} played ${p.offBoard} move(s) not on its shortlist`)

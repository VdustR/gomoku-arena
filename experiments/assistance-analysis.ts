/**
 * Read a set of finished matches for more than who won.
 *
 *   node experiments/assistance-analysis.ts <matches.json> [out.md]
 *
 * A win rate over twelve games is nearly all noise, so the figures that carry
 * the most signal here are the ones measured per move rather than per game:
 * how long a seat took, how often it departed from the heuristic that fed it,
 * how often the page answered for it, and what shape the games took. Those
 * have hundreds of observations behind them instead of twelve.
 *
 * Every number is read back from the server's record or recomputed from the
 * move list. Nothing is taken from what a player said about itself.
 */

import { EMPTY, BLACK, WHITE, SIZE, idx } from '../src/lib/rules.ts'
import type { Board, Side } from '../src/lib/rules.ts'
import { candidateMoves } from '../src/lib/ai/heuristic.ts'
import { assistanceFor } from '../src/lib/ai/providers.ts'
import type { Review, ReviewMove } from '../server/match.ts'
import { readFileSync, writeFileSync } from 'node:fs'

const FILE = process.argv[2]
const OUT = process.argv[3]
const BASE = process.env['GOMOKU_URL'] ?? 'http://localhost:5273'
const COLUMNS = 'ABCDEFGHJKLMNOP'

if (!FILE) {
  console.error('usage: node experiments/assistance-analysis.ts <matches.json> [out.md]')
  process.exit(2)
}

interface Played {
  id: string
  black: string
  white: string
  status: string
  winner: string | null
  moves: number
}

const played = JSON.parse(readFileSync(FILE, 'utf8')) as Played[]

const pointOf = (label: string) => ({
  x: COLUMNS.indexOf(label[0] ?? ''),
  y: SIZE - Number(label.slice(1)),
})

/** Everything tracked per entrant, accumulated across its games. */
interface Tally {
  id: string
  wins: number
  draws: number
  losses: number
  asBlack: { w: number; d: number; l: number }
  asWhite: { w: number; d: number; l: number }
  thinking: number[]
  forcedTake: number
  forcedBlock: number
  modelMoves: number
  ranks: number[]
  offShortlist: number
  rejected: number
  gameLengths: number[]
}

const tallies = new Map<string, Tally>()
const seed = (id: string): Tally => {
  let t = tallies.get(id)
  if (!t) {
    t = {
      id,
      wins: 0,
      draws: 0,
      losses: 0,
      asBlack: { w: 0, d: 0, l: 0 },
      asWhite: { w: 0, d: 0, l: 0 },
      thinking: [],
      forcedTake: 0,
      forcedBlock: 0,
      modelMoves: 0,
      ranks: [],
      offShortlist: 0,
      rejected: 0,
      gameLengths: [],
    }
    tallies.set(id, t)
  }
  return t
}

interface GameShape {
  id: string
  black: string
  white: string
  moves: number
  winner: string | null
  status: string
  orientation: string
  lineLength: number
  firstBlood: number | null
}

const shapes: GameShape[] = []

/** Where the winning line runs, which turns out to split by direction. */
function orientationOf(stones: string[]): { orientation: string; lineLength: number } {
  if (stones.length === 0) return { orientation: 'none', lineLength: 0 }
  const pts = stones.map(pointOf).sort((a, b) => a.x - b.x || a.y - b.y)
  const a = pts[0]
  const b = pts[1]
  if (!a || !b) return { orientation: 'none', lineLength: stones.length }
  const dx = b.x - a.x
  const dy = b.y - a.y
  const orientation = dy === 0 ? 'row' : dx === 0 ? 'column' : 'diagonal'
  return { orientation, lineLength: stones.length }
}

for (const game of played) {
  const review = (await (await fetch(`${BASE}/api/match/${game.id}/review`)).json()) as Review
  const seats: Record<Side | number, string> = { [BLACK]: game.black, [WHITE]: game.white }
  const bySeat = { black: game.black, white: game.white }

  for (const side of ['black', 'white'] as const) {
    const t = seed(bySeat[side])
    t.rejected += review.sides[side].rejected
    t.gameLengths.push(review.moves.length)
    const bucket = side === 'black' ? t.asBlack : t.asWhite
    if (review.status === 'draw') {
      t.draws++
      bucket.d++
    } else if (review.winner === side) {
      t.wins++
      bucket.w++
    } else {
      t.losses++
      bucket.l++
    }
  }

  // Replay for the shortlist rank of every move a model actually chose.
  const board: Board = new Uint8Array(SIZE * SIZE).fill(EMPTY)
  let firstBlood: number | null = null
  for (const move of review.moves as ReviewMove[]) {
    const side = move.seat === 'black' ? BLACK : WHITE
    const id = seats[side] as string
    const t = seed(id)
    t.thinking.push(move.thinkingMs)

    /*
     * `metrics` is optional-or-absent, so the empty fallback has no members
     * to speak of. Reading it as a loose bag is honest here: the keys are
     * whatever the player could account for, which is the whole point of the
     * field, and `model === 'forced move'` is the one the page writes itself.
     */
    const metrics: Record<string, unknown> = move.metrics ?? {}
    if (metrics['model'] === 'forced move') {
      if (String(metrics['work'] ?? '').includes('Winning move')) t.forcedTake++
      else t.forcedBlock++
    } else if (id !== 'greedy') {
      const aid = assistanceFor(id)
      const shortlist = candidateMoves(board, side, review.ruleSet, {
        limit: aid.candidateLimit,
        scope: aid.candidateLimit == null ? 'board' : 'relevant',
      })
      const rank = shortlist.findIndex((c) => c.label === move.point)
      if (rank === -1) t.offShortlist++
      else {
        t.modelMoves++
        t.ranks.push(rank)
      }
    }

    // The first move either side plays that makes a four or better.
    if (firstBlood === null) {
      const { x, y } = pointOf(move.point)
      const shortlist = candidateMoves(board, side, review.ruleSet, { limit: null })
      const chosen = shortlist.find((c) => c.x === x && c.y === y)
      if (chosen && ['four', 'open-four', 'five'].includes(chosen.attack)) firstBlood = move.n
    }

    const { x, y } = pointOf(move.point)
    board[idx(x, y)] = side
  }

  const { orientation, lineLength } = orientationOf(review.winningStones)
  shapes.push({
    id: game.id,
    black: game.black,
    white: game.white,
    moves: review.moves.length,
    winner: review.winner,
    status: review.status,
    orientation,
    lineLength,
    firstBlood,
  })
}

const num = (xs: number[]) => [...xs].sort((a, b) => a - b)
const median = (xs: number[]) => {
  const s = num(xs)
  if (s.length === 0) return null
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? (s[mid] as number) : Math.round(((s[mid - 1] as number) + (s[mid] as number)) / 2)
}
const pctl = (xs: number[], p: number) => {
  const s = num(xs)
  if (s.length === 0) return null
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))] as number
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const ms = (v: number | null) => (v == null ? '—' : v < 1000 ? `${v}ms` : `${(v / 1000).toFixed(2)}s`)
const pc = (n: number, d: number) => (d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%`)

const NAMES: Record<string, string> = {
  jev: 'Jev — assisted',
  'jev-shortlisted': 'Jev — shortlisted',
  'jev-unaided': 'Jev — unaided',
  greedy: 'Greedy heuristic',
}
const ORDER = ['jev', 'jev-shortlisted', 'jev-unaided', 'greedy']
const entrants = ORDER.filter((id) => tallies.has(id)).map((id) => tallies.get(id) as Tally)

const lines: string[] = []
const say = (s = '') => lines.push(s)

say('# One model, three levels of help')
say()
say(`${played.length} matches, free style, 15x15. Every pairing played twice so each side`)
say('gets black once. Three of the four entrants are the same model behind the same')
say('endpoint; only what the page does for them differs.')
say()
say('| Seat | Points offered | Heuristic’s reading attached | Takes/blocks a five for it |')
say('| --- | --- | --- | --- |')
for (const id of ORDER) {
  if (id === 'greedy') {
    say('| Greedy heuristic | — | it *is* the heuristic | n/a |')
    continue
  }
  const a = assistanceFor(id)
  say(
    `| ${NAMES[id]} | ${a.candidateLimit ?? 'every legal point'} | ${a.rationale ? 'yes' : 'no'} | ${a.forced ? 'yes' : 'no'} |`,
  )
}
say()

say('## Results')
say()
say('| Seat | W | D | L | As black | As white |')
say('| --- | --- | --- | --- | --- | --- |')
for (const t of entrants) {
  const r = (b: { w: number; d: number; l: number }) => `${b.w}-${b.d}-${b.l}`
  say(`| ${NAMES[t.id]} | ${t.wins} | ${t.draws} | ${t.losses} | ${r(t.asBlack)} | ${r(t.asWhite)} |`)
}
say()

say('## Reaction time')
say()
say('Measured by the server for every seat the same way, so it compares directly.')
say('The spread matters more than the median: a seat whose slowest move is far from')
say('its median is one that sometimes had to think, and a flat distribution is a')
say('seat that answered every position with the same effort.')
say()
say('| Seat | Median | Mean | p90 | Slowest | Moves |')
say('| --- | --- | --- | --- | --- | --- |')
for (const t of entrants) {
  say(
    `| ${NAMES[t.id]} | ${ms(median(t.thinking))} | ${ms(Math.round(mean(t.thinking) ?? 0))} | ` +
      `${ms(pctl(t.thinking, 0.9))} | ${ms(pctl(t.thinking, 1))} | ${t.thinking.length} |`,
  )
}
say()

say('## How much of each seat was the model')
say()
say('A "forced" move never reached the model: the page took a five, or blocked one.')
say('For everything else, the shortlist that seat would have been offered is')
say('recomputed and the played move located in it. Rank 0 is the heuristic’s own')
say('first choice, so a seat sitting at rank 0 is not contributing a decision.')
say()
say('| Seat | Model-chosen | Took rank 1 | Mean rank | Forced: took a win | Forced: blocked a five |')
say('| --- | --- | --- | --- | --- | --- |')
for (const t of entrants) {
  if (t.id === 'greedy') {
    say(`| ${NAMES[t.id]} | — | it is rank 1 by definition | 0.00 | — | — |`)
    continue
  }
  const top = t.ranks.filter((r) => r === 0).length
  say(
    `| ${NAMES[t.id]} | ${t.modelMoves} | ${top} (${pc(top, t.modelMoves)}) | ` +
      `${(mean(t.ranks) ?? 0).toFixed(2)} | ${t.forcedTake} | ${t.forcedBlock} |`,
  )
}
say()

say('## The shape of the games')
say()
say('| Black | White | Result | Moves | Winning line | First four |')
say('| --- | --- | --- | --- | --- | --- |')
for (const g of shapes) {
  const outcome = g.status === 'draw' ? 'draw' : `${g.winner} wins`
  const line =
    g.orientation === 'none' ? '—' : `${g.orientation}${g.lineLength > 5 ? ` (${g.lineLength})` : ''}`
  say(
    `| ${NAMES[g.black]} | ${NAMES[g.white]} | ${outcome} | ${g.moves} | ${line} | ${g.firstBlood ?? '—'} |`,
  )
}
say()

const byOrientation = new Map<string, number>()
for (const g of shapes) byOrientation.set(g.orientation, (byOrientation.get(g.orientation) ?? 0) + 1)
say('Winning lines by direction: ' + [...byOrientation].map(([k, v]) => `${k} ${v}`).join(', ') + '.')
say()
const blackWins = shapes.filter((g) => g.winner === 'black').length
const whiteWins = shapes.filter((g) => g.winner === 'white').length
say(`Black won ${blackWins}, white won ${whiteWins}, ${shapes.length - blackWins - whiteWins} drawn.`)
say()
say('| Seat | Shortest game | Median | Longest | Illegal moves |')
say('| --- | --- | --- | --- | --- |')
for (const t of entrants) {
  say(
    `| ${NAMES[t.id]} | ${num(t.gameLengths)[0] ?? '—'} | ${median(t.gameLengths) ?? '—'} | ` +
      `${num(t.gameLengths).at(-1) ?? '—'} | ${t.rejected} |`,
  )
}
say()

const body = lines.join('\n') + '\n'
if (OUT) {
  writeFileSync(OUT, body)
  console.error(`wrote ${OUT}`)
}
console.log(body)

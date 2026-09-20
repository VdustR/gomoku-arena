/**
 * Build the report for a set of finished matches.
 *
 *   node experiments/tournament-report.ts <out.md> <tag=match-id> [tag=match-id ...]
 *
 * Every number printed here is read back from the server's own record. Two
 * distinctions the arena makes are kept rather than flattened:
 *
 * - Thinking time is measured by the server and is the only figure comparable
 *   across players. Everything under a move's `metrics` is what that player
 *   could account for, and carries the source that produced it.
 *
 * - A move whose `metrics.model` is "forced move" was not chosen by the player
 *   at all. The page takes a five in a row, and blocks the opponent's, without
 *   a round trip. Only seats the page drives get that; a seat played by an
 *   agent over MCP has to see every five itself. Counting those moves is the
 *   difference between "this model won" and "this model plus a shortcut won".
 */

import type { Review, SeatName } from '../server/match.ts'

const [OUT, ...pairs] = process.argv.slice(2)
const BASE = process.env['GOMOKU_URL'] ?? 'http://localhost:5273'

if (!OUT || pairs.length === 0) {
  console.error('usage: node experiments/tournament-report.ts <out.md> <tag=match-id> ...')
  process.exit(2)
}

const ms = (v: number | null | undefined): string =>
  v == null ? '—' : v < 1000 ? `${v}ms` : `${(v / 1000).toFixed(1)}s`
const pct = (n: number, d: number): string => (d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%`)

const matches: { tag: string; review: Review }[] = []
for (const pair of pairs) {
  const [tag = pair, id] = pair.split('=')
  const response = await fetch(`${BASE}/api/match/${id}/review`)
  if (!response.ok) {
    console.error(`could not read ${tag} (${id}): ${response.status}`)
    process.exit(1)
  }
  const review = (await response.json()) as Review
  if (review.status === 'playing') {
    console.error(`${tag} is still playing; refusing to report an unfinished match`)
    process.exit(1)
  }
  matches.push({ tag, review })
}

/** Wins, draws and losses in one seat colour. */
interface SeatRecord {
  wins: number
  draws: number
  losses: number
}

interface Player {
  /** The label the record carries, which is null for a move nobody signed. */
  name: string | null
  moves: number
  forced: number
  thinkingMs: number
  wins: number
  draws: number
  losses: number
  asBlack: SeatRecord
  asWhite: SeatRecord
  slowestMs: number
  medians: number[]
  rejected: number
  /*
   * How this seat reached the board, taken from the server's own seat
   * record rather than guessed from whether the shortcut ever fired. An
   * in-page seat that never happened to meet a five would otherwise be
   * filed as an agent, which is the distinction this table exists for.
   */
  kinds: Set<string>
}

/** Per-player totals, kept separately for black and white. */
const players = new Map<string | null, Player>()
const seed = (name: string | null): Player => {
  const found = players.get(name)
  if (found) return found
  const player: Player = {
    name,
    moves: 0,
    forced: 0,
    thinkingMs: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    asBlack: { wins: 0, draws: 0, losses: 0 },
    asWhite: { wins: 0, draws: 0, losses: 0 },
    slowestMs: 0,
    medians: [],
    rejected: 0,
    kinds: new Set(),
  }
  players.set(name, player)
  return player
}

const SEATS: SeatName[] = ['black', 'white']

for (const { review } of matches) {
  for (const seat of SEATS) {
    const side = review.sides[seat]
    const p = seed(side.player.label ?? side.player.kind)
    p.kinds.add(side.player.kind)
    p.moves += side.moves
    p.rejected += side.rejected
    p.thinkingMs += side.thinking.totalMs
    p.slowestMs = Math.max(p.slowestMs, side.thinking.slowestMs ?? 0)
    if (side.thinking.medianMs != null) p.medians.push(side.thinking.medianMs)
    const bucket = seat === 'black' ? p.asBlack : p.asWhite
    if (review.status === 'draw') {
      p.draws++
      bucket.draws++
    } else if (review.winner === seat) {
      p.wins++
      bucket.wins++
    } else {
      p.losses++
      bucket.losses++
    }
  }
  for (const move of review.moves) {
    const p = seed(move.by)
    if (move.metrics?.['model'] === 'forced move') p.forced++
  }
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  const high = s[mid] ?? null
  if (high === null) return null
  if (s.length % 2) return high
  const low = s[mid - 1] ?? high
  return Math.round((low + high) / 2)
}

const lines: string[] = []
const say = (s = ''): number => lines.push(s)

say('# Gomoku Arena — model comparison')
say()
say(`${matches.length} matches, free style, 15x15. Every figure below is read back from the`)
say('server record rather than from what a player reported about itself.')
say()

say('## Results')
say()
say('| # | Black | White | Result | Moves | Winning line | Duration |')
say('| --- | --- | --- | --- | --- | --- | --- |')
for (const { tag, review } of matches) {
  const b = review.sides.black.player.label
  const w = review.sides.white.player.label
  const outcome = review.status === 'draw' ? 'draw' : `${review.winner === 'black' ? 'black' : 'white'} wins`
  const line = review.winningStones.length ? review.winningStones.join(' ') : '—'
  say(`| ${tag} | ${b} | ${w} | ${outcome} | ${review.moves.length} | ${line} | ${ms(review.durationMs)} |`)
}
say()

say('## Standings')
say()
say('| Player | W | D | L | As black | As white |')
say('| --- | --- | --- | --- | --- | --- |')
const ranked = [...players.values()].sort((a, b) => b.wins - a.wins || a.losses - b.losses)
for (const p of ranked) {
  const rec = (r: SeatRecord): string => `${r.wins}-${r.draws}-${r.losses}`
  say(`| ${p.name} | ${p.wins} | ${p.draws} | ${p.losses} | ${rec(p.asBlack)} | ${rec(p.asWhite)} |`)
}
say()

say('## How much of each player was the player')
say()
say('A "forced move" is one the page played without consulting the model: taking a')
say("five in a row, or blocking the opponent's. Only a seat the page drives gets")
say('that shortcut. A seat played by an agent over MCP gets none of it and has to')
say('see every five for itself, so these two groups are not playing under the same')
say('conditions.')
say()
say('| Player | Transport | Moves | Forced by the page | Share |')
say('| --- | --- | --- | --- | --- |')
const TRANSPORT: Record<string, string> = {
  engine: 'in-page seat',
  agent: 'agent over MCP',
  human: 'person at the board',
}
for (const p of ranked) {
  const transport = [...p.kinds].map((k) => TRANSPORT[k] ?? k).join(', ')
  say(`| ${p.name} | ${transport} | ${p.moves} | ${p.forced} | ${pct(p.forced, p.moves)} |`)
}
say()

say('## Thinking time')
say()
say('Measured by the server for every player the same way, so this is the one')
say('figure that compares directly.')
say()
say('| Player | Median of per-match medians | Slowest single move | Total | Illegal moves |')
say('| --- | --- | --- | --- | --- |')
for (const p of ranked) {
  say(`| ${p.name} | ${ms(median(p.medians))} | ${ms(p.slowestMs)} | ${ms(p.thinkingMs)} | ${p.rejected} |`)
}
say()

const body = lines.join('\n') + '\n'
const { writeFileSync, mkdirSync } = await import('node:fs')
const { dirname } = await import('node:path')
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, body)
console.log(body)
console.error(`wrote ${OUT}`)

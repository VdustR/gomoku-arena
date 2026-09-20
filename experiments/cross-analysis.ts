/**
 * Read a five-way cross table for more than who won.
 *
 *   node experiments/cross-analysis.ts <matches.json> [more.json ...] [--out FILE]
 *
 * Twenty games is not enough for a win rate to mean much, so the figures that
 * carry weight here are per move rather than per game: reaction time, how far
 * each seat departed from the heuristic that fed it, how often the page
 * answered on its behalf, and how the games actually ended. Those have
 * hundreds of observations behind them.
 *
 * Every number is read from the server's own record or recomputed from the
 * move list. Nothing is taken from what a player said about itself.
 */

import { EMPTY, BLACK, WHITE, SIZE, idx } from '../src/lib/rules.ts'
import type { Board, Side } from '../src/lib/rules.ts'
import { candidateMoves } from '../src/lib/ai/heuristic.ts'
import { assistanceFor } from '../src/lib/ai/providers.ts'
import type { Review } from '../server/match.ts'
import { readFileSync, writeFileSync } from 'node:fs'

const BASE = process.env['GOMOKU_URL'] ?? 'http://localhost:5273'
const COLUMNS = 'ABCDEFGHJKLMNOP'

const args = process.argv.slice(2)
const outAt = args.indexOf('--out')
const OUT = outAt === -1 ? null : args[outAt + 1]
const files = (outAt === -1 ? args : args.slice(0, outAt)).filter(Boolean)
if (files.length === 0) {
  console.error('usage: node experiments/cross-analysis.ts <matches.json> ... [--out FILE]')
  process.exit(2)
}

interface Played {
  id: string
  black: string
  white: string
}

const played: Played[] = files.flatMap((f) => JSON.parse(readFileSync(f, 'utf8')) as Played[])

const NAMES: Record<string, string> = {
  'jev-unaided': 'Jev 無輔助',
  'jev-shortlisted': 'Jev 微輔助',
  'browser-shortlisted': 'Chrome 內建(微輔助)',
  'agent:sonnet': 'Claude Code Sonnet',
  'agent:antigravity': 'Antigravity Gemini 3.8 Flash',
}
const ORDER = ['agent:sonnet', 'agent:antigravity', 'browser-shortlisted', 'jev-shortlisted', 'jev-unaided']

/*
 * Short labels for the tables. The full names are spelled out once in the
 * roster; repeating "Antigravity Gemini 3.8 Flash" three times inside a
 * single cell makes the row harder to scan than the fact it carries.
 */
const SHORT: Record<string, string> = {
  'jev-unaided': 'Jev 無輔助',
  'jev-shortlisted': 'Jev 微輔助',
  'browser-shortlisted': 'Chrome',
  'agent:sonnet': 'Sonnet',
  'agent:antigravity': 'Antigravity',
}
const isAgent = (id: string) => id.startsWith('agent:')

const pointOf = (label: string) => ({
  x: COLUMNS.indexOf(label[0] ?? ''),
  y: SIZE - Number(label.slice(1)),
})

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
      rejected: 0,
      gameLengths: [],
    }
    tallies.set(id, t)
  }
  return t
}

interface GameRow {
  black: string
  white: string
  winner: string | null
  status: string
  moves: number
  orientation: string
  lineLength: number
}
const games: GameRow[] = []
/** head-to-head: key `${a}|${b}` counts a's wins over b. */
const head = new Map<string, number>()

function orientationOf(stones: string[]): { orientation: string; lineLength: number } {
  if (stones.length === 0) return { orientation: '—', lineLength: 0 }
  const pts = stones.map(pointOf).sort((a, b) => a.x - b.x || a.y - b.y)
  const a = pts[0]
  const b = pts[1]
  if (!a || !b) return { orientation: '—', lineLength: stones.length }
  const orientation = b.y - a.y === 0 ? '橫列' : b.x - a.x === 0 ? '直行' : '斜線'
  return { orientation, lineLength: stones.length }
}

for (const game of played) {
  const review = (await (await fetch(`${BASE}/api/match/${game.id}/review`)).json()) as Review
  if (review.status === 'playing') {
    console.error(`skipping ${game.id.slice(0, 8)}: still playing`)
    continue
  }
  const bySeat = { black: game.black, white: game.white }
  const seats: Record<number, string> = { [BLACK]: game.black, [WHITE]: game.white }

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
  if (review.status !== 'draw') {
    const won = review.winner === 'black' ? game.black : game.white
    const lost = review.winner === 'black' ? game.white : game.black
    const key = `${won}|${lost}`
    head.set(key, (head.get(key) ?? 0) + 1)
  }

  const board: Board = new Uint8Array(SIZE * SIZE).fill(EMPTY)
  for (const move of review.moves) {
    const side: Side = move.seat === 'black' ? BLACK : WHITE
    const id = seats[side] as string
    const t = seed(id)
    t.thinking.push(move.thinkingMs)
    const metrics: Record<string, unknown> = move.metrics ?? {}
    if (metrics['model'] === 'forced move') {
      const work = metrics['work']
      if (typeof work === 'string' && work.includes('Winning move')) t.forcedTake++
      else t.forcedBlock++
    } else if (!isAgent(id)) {
      const aid = assistanceFor(id)
      const shortlist = candidateMoves(board, side, review.ruleSet, {
        limit: aid.candidateLimit,
        scope: aid.candidateLimit == null ? 'board' : 'relevant',
      })
      const rank = shortlist.findIndex((c) => c.label === move.point)
      if (rank !== -1) {
        t.modelMoves++
        t.ranks.push(rank)
      }
    }
    const { x, y } = pointOf(move.point)
    board[idx(x, y)] = side
  }

  const { orientation, lineLength } = orientationOf(review.winningStones)
  games.push({
    black: game.black,
    white: game.white,
    winner: review.winner,
    status: review.status,
    moves: review.moves.length,
    orientation,
    lineLength,
  })
}

const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b)
const median = (xs: number[]) => {
  const s = sorted(xs)
  if (s.length === 0) return null
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? (s[mid] as number) : Math.round(((s[mid - 1] as number) + (s[mid] as number)) / 2)
}
const pctl = (xs: number[], p: number) => {
  const s = sorted(xs)
  return s.length === 0 ? null : (s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))] as number)
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const ms = (v: number | null) => (v == null ? '—' : v < 1000 ? `${v}ms` : `${(v / 1000).toFixed(2)}s`)

const entrants = ORDER.filter((id) => tallies.has(id)).map((id) => tallies.get(id) as Tally)
const lines: string[] = []
const say = (s = '') => lines.push(s)

say('# 五方交叉對戰結果')
say()
say(`共 ${games.length} 場,free style,15x15 棋盤,每組配對黑白各一場。`)
say()

say('## 總成績')
say()
say('| 參賽者 | 勝 | 和 | 負 | 執黑 | 執白 |')
say('| --- | --- | --- | --- | --- | --- |')
for (const t of entrants) {
  const r = (b: { w: number; d: number; l: number }) => `${b.w}-${b.d}-${b.l}`
  say(`| ${NAMES[t.id]} | ${t.wins} | ${t.draws} | ${t.losses} | ${r(t.asBlack)} | ${r(t.asWhite)} |`)
}
say()

say('## 交叉戰績')
say()
say('每格是那一局的**贏家**,括號是贏家當時執的顏色。列 = 執黑方,欄 = 執白方。')
say('所以同一組配對會出現在對稱的兩格,分別是它執黑和執白的那一場。')
say()
say('| 黑方 ＼ 白方 | ' + entrants.map((t) => SHORT[t.id]).join(' | ') + ' |')
say('| --- |' + entrants.map(() => ' --- |').join(''))
for (const a of entrants) {
  const cells = entrants.map((b) => {
    if (a.id === b.id) return '—'
    const g = games.find((x) => x.black === a.id && x.white === b.id)
    if (!g) return '—'
    if (g.status === 'draw') return '和局'
    const winner = g.winner === 'black' ? a.id : b.id
    return `**${SHORT[winner]}**(${g.winner === 'black' ? '黑' : '白'})`
  })
  say(`| **${SHORT[a.id]}** | ${cells.join(' | ')} |`)
}
say()
say('### 每組配對打兩場,誰贏')
say()
say('| 配對 | 誰贏 | 兩場怎麼贏的 |')
say('| --- | --- | --- |')
const seen = new Set<string>()
for (const a of entrants) {
  for (const b of entrants) {
    if (a.id === b.id) continue
    const key = [a.id, b.id].sort().join('|')
    if (seen.has(key)) continue
    seen.add(key)
    const both = [
      games.find((x) => x.black === a.id && x.white === b.id),
      games.find((x) => x.black === b.id && x.white === a.id),
    ].filter(Boolean) as GameRow[]
    if (both.length === 0) continue

    /*
     * Each game is described by the winner and the colour that winner held,
     * so a row can be read on its own. An earlier version said "前者執黑",
     * which made the reader hold on to which name came first.
     */
    const detail = both
      .map((g) => {
        if (g.status === 'draw') return `和局 ${g.moves} 手`
        const w = g.winner === 'black' ? g.black : g.white
        const colour = g.winner === 'black' ? '執黑' : '執白'
        // Name the winner only when the two games were won by different
        // players; otherwise the verdict column already said who.
        const mixed = new Set(
          both.filter((x) => x.status !== 'draw').map((x) => (x.winner === 'black' ? x.black : x.white)),
        ).size
        return mixed > 1 ? `${SHORT[w]} ${colour} ${g.moves} 手` : `${colour} ${g.moves} 手`
      })
      .join('、')

    const tally = new Map<string, number>()
    for (const g of both) {
      if (g.status === 'draw') continue
      const w = g.winner === 'black' ? g.black : g.white
      tally.set(w, (tally.get(w) ?? 0) + 1)
    }
    const ranked = [...tally].sort((x, y) => y[1] - x[1])
    const top = ranked[0]
    let verdict: string
    if (!top) verdict = '兩場都和局'
    else if (ranked.length === 1 && top[1] === both.length) verdict = `**${SHORT[top[0]]}** 兩場都贏`
    else verdict = '各勝一場,顏色決定'

    say(`| ${SHORT[a.id]} vs ${SHORT[b.id]} | ${verdict} | ${detail} |`)
  }
}
say()

say('## 反應時間')
say()
say('由伺服器統一量測,是唯一可直接互相比較的數字。')
say()
say('| 參賽者 | 中位數 | 平均 | p90 | 最慢 | 手數 |')
say('| --- | --- | --- | --- | --- | --- |')
for (const t of entrants) {
  say(
    `| ${NAMES[t.id]} | ${ms(median(t.thinking))} | ${ms(Math.round(mean(t.thinking) ?? 0))} | ` +
      `${ms(pctl(t.thinking, 0.9))} | ${ms(pctl(t.thinking, 1))} | ${t.thinking.length} |`,
  )
}
say()

say('## 有多少是模型自己下的')
say()
say('forced 是頁面沒問模型就代下的手:自己成五、或擋對手成五。其餘的手會重算')
say('該座位當時會拿到的候選清單,再看實際下的點排在第幾名。名次 0 代表採用')
say('heuristic 的第一順位 —— 完全貼齊就等於沒有貢獻判斷。')
say('走 MCP 的 agent 沒有清單也沒有捷徑,所以這兩欄不適用。')
say()
say('| 參賽者 | 模型自選手數 | 取第一順位 | 平均名次 | forced 成五 | forced 擋五 |')
say('| --- | --- | --- | --- | --- | --- |')
for (const t of entrants) {
  if (isAgent(t.id)) {
    say(`| ${NAMES[t.id]} | ${t.thinking.length}(全部自選) | 不適用 | 不適用 | 0 | 0 |`)
    continue
  }
  const top = t.ranks.filter((r) => r === 0).length
  const share = t.modelMoves ? `${((top / t.modelMoves) * 100).toFixed(1)}%` : '—'
  say(
    `| ${NAMES[t.id]} | ${t.modelMoves} | ${top}(${share}) | ${(mean(t.ranks) ?? 0).toFixed(2)} | ` +
      `${t.forcedTake} | ${t.forcedBlock} |`,
  )
}
say()

say('## 每一局')
say()
say('| 黑方 | 白方 | 勝方 | 手數 | 致勝線 |')
say('| --- | --- | --- | --- | --- |')
for (const g of games) {
  const outcome =
    g.status === 'draw'
      ? '和局'
      : `${NAMES[g.winner === 'black' ? g.black : g.white]}(執${g.winner === 'black' ? '黑' : '白'})`
  const line =
    g.orientation === '—' ? '—' : `${g.orientation}${g.lineLength > 5 ? `(${g.lineLength} 子)` : ''}`
  say(`| ${NAMES[g.black]} | ${NAMES[g.white]} | ${outcome} | ${g.moves} | ${line} |`)
}
say()

const byDir = new Map<string, number>()
for (const g of games) byDir.set(g.orientation, (byDir.get(g.orientation) ?? 0) + 1)
const blackWins = games.filter((g) => g.winner === 'black').length
const whiteWins = games.filter((g) => g.winner === 'white').length
say(`致勝線方向:${[...byDir].map(([k, v]) => `${k} ${v}`).join('、')}。`)
say()
say(`執黑方勝 ${blackWins} 場,執白方勝 ${whiteWins} 場,和局 ${games.length - blackWins - whiteWins} 場。`)
say()
say('| 參賽者 | 最短局 | 中位數 | 最長局 | 違規手 |')
say('| --- | --- | --- | --- | --- |')
for (const t of entrants) {
  say(
    `| ${NAMES[t.id]} | ${sorted(t.gameLengths)[0] ?? '—'} | ${median(t.gameLengths) ?? '—'} | ` +
      `${sorted(t.gameLengths).at(-1) ?? '—'} | ${t.rejected} |`,
  )
}
say()

const body = lines.join('\n') + '\n'
if (OUT) {
  writeFileSync(OUT, body)
  console.error(`wrote ${OUT}`)
}
console.log(body)

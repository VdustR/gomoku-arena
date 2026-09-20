/**
 * What each player actually does on the board.
 *
 *   node experiments/play-style.ts <matches.json> [--out FILE]
 *
 * A result table says who won. It does not say whether a player attacked or
 * answered, whether it saw the threats against it, or how far its stones sat
 * from the fight. Those are properties of the play itself, they have one
 * observation per move rather than one per game, and they are what separates
 * two players with the same record.
 *
 * Every figure is recomputed from the stored move list against the project's
 * own rules. Nothing is taken from what a player said about its own move.
 */

import { EMPTY, BLACK, WHITE, SIZE, idx } from '../src/lib/rules.ts'
import type { Board, Side } from '../src/lib/rules.ts'
import { bestShape, candidateMoves } from '../src/lib/ai/heuristic.ts'
import type { Shape } from '../src/lib/ai/heuristic.ts'
import type { Review } from '../server/match.ts'
import { readFileSync, writeFileSync } from 'node:fs'

const BASE = process.env['GOMOKU_URL'] ?? 'http://localhost:5273'
const COLUMNS = 'ABCDEFGHJKLMNOP'

const args = process.argv.slice(2)
const outAt = args.indexOf('--out')
const OUT = outAt === -1 ? null : args[outAt + 1]
const FILE = args[0]
if (!FILE) {
  console.error('usage: node experiments/play-style.ts <matches.json> [--out FILE]')
  process.exit(2)
}

interface Played {
  id: string
  black: string
  white: string
}
const played = JSON.parse(readFileSync(FILE, 'utf8')) as Played[]

const SHORT: Record<string, string> = {
  'jev-unaided': 'Jev 無輔助',
  'jev-shortlisted': 'Jev 微輔助',
  'browser-shortlisted': 'Chrome',
  'agent:sonnet': 'Sonnet',
  'agent:antigravity': 'Antigravity',
}
const ORDER = ['agent:sonnet', 'agent:antigravity', 'browser-shortlisted', 'jev-shortlisted', 'jev-unaided']

const pointOf = (label: string) => ({
  x: COLUMNS.indexOf(label[0] ?? ''),
  y: SIZE - Number(label.slice(1)),
})

/**
 * Shapes that demand an answer on the very next move, most urgent first.
 *
 * `urgency` returns -1 for everything else, so every comparison has to check
 * for that first: `-1 <= 2` is true, which would count an open two as an
 * answer to a four.
 */
const URGENT: Shape[] = ['five', 'open-four', 'four', 'open-three']
const urgency = (s: Shape) => URGENT.indexOf(s)
const isUrgent = (s: Shape) => urgency(s) !== -1
/** Does playing this point address a threat of at least `standing`? */
const addresses = (theirs: Shape, standing: Shape) =>
  isUrgent(theirs) && isUrgent(standing) && urgency(theirs) <= urgency(standing)

interface Style {
  id: string
  moves: number
  opening: string[]
  /** Moves that built a four or better for the player. */
  attacks: number
  /** Moves that removed an end from the opponent's four or open three. */
  blocks: number
  /** Moves that did both at once. */
  dual: number
  /** Moves that did neither: quiet development. */
  quiet: number
  /** Times an opponent four or open three stood and the player answered it. */
  answered: number
  /** Times one stood and the player played elsewhere. */
  missed: number
  thinking: number[]
  /** Where the played move sat in the heuristic's own ranking, in-page seats only. */
  ranks: number[]
  wins: number
  winByDouble: number
}

const styles = new Map<string, Style>()
const seed = (id: string): Style => {
  let s = styles.get(id)
  if (!s) {
    s = {
      id,
      moves: 0,
      opening: [],
      attacks: 0,
      blocks: 0,
      dual: 0,
      quiet: 0,
      answered: 0,
      missed: 0,
      thinking: [],
      ranks: [],
      wins: 0,
      winByDouble: 0,
    }
    styles.set(id, s)
  }
  return s
}

/** The strongest shape `side` already threatens anywhere on the board. */
function standingThreat(board: Board, side: Side): Shape {
  let best: Shape = 'none'
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      if (board[idx(x, y)] !== EMPTY) continue
      const shape = bestShape(board, x, y, side, SIZE)
      if (isUrgent(shape) && (!isUrgent(best) || urgency(shape) < urgency(best))) best = shape
    }
  }
  return best
}

for (const game of played) {
  const review = (await (await fetch(`${BASE}/api/match/${game.id}/review`)).json()) as Review
  if (review.status === 'playing') continue
  const seats: Record<number, string> = { [BLACK]: game.black, [WHITE]: game.white }
  const board: Board = new Uint8Array(SIZE * SIZE).fill(EMPTY)

  for (const move of review.moves) {
    const side: Side = move.seat === 'black' ? BLACK : WHITE
    const foe: Side = side === BLACK ? WHITE : BLACK
    const id = seats[side] as string
    const st = seed(id)
    st.moves += 1
    st.thinking.push(move.thinkingMs)
    if (move.n <= 2) st.opening.push(move.point)

    const { x, y } = pointOf(move.point)

    // What the move did, judged before it landed.
    const threatBefore = standingThreat(board, foe)
    const mine = bestShape(board, x, y, side, SIZE)
    const theirs = bestShape(board, x, y, foe, SIZE)
    const isAttack = isUrgent(mine)
    const isBlock = addresses(theirs, threatBefore)
    if (isAttack && isBlock) st.dual += 1
    else if (isAttack) st.attacks += 1
    else if (isBlock) st.blocks += 1
    else st.quiet += 1

    // Did the player answer a threat that was already on the board?
    if (isUrgent(threatBefore)) {
      if (addresses(theirs, threatBefore)) st.answered += 1
      else st.missed += 1
    }

    const metrics: Record<string, unknown> = move.metrics ?? {}
    if (!id.startsWith('agent:') && metrics['model'] !== 'forced move') {
      const shortlist = candidateMoves(board, side, review.ruleSet, { limit: null, scope: 'board' })
      const r = shortlist.findIndex((c) => c.label === move.point)
      if (r !== -1) st.ranks.push(r)
    }

    board[idx(x, y)] = side
  }

  if (review.status === 'win' && review.winner) {
    const winner = review.winner === 'black' ? game.black : game.white
    const st = seed(winner)
    st.wins += 1
    /*
     * Was the last move a fork? Replay to the position before it and count how
     * many distinct lines through that point were already a four or an open
     * three. Two or more means the loser could not have blocked both.
     */
    const last = review.moves.at(-1)
    if (last) {
      const replay: Board = new Uint8Array(SIZE * SIZE).fill(EMPTY)
      for (const m of review.moves.slice(0, -1)) {
        const s2: Side = m.seat === 'black' ? BLACK : WHITE
        const p = pointOf(m.point)
        replay[idx(p.x, p.y)] = s2
      }
      const side: Side = last.seat === 'black' ? BLACK : WHITE
      const p = pointOf(last.point)
      let lines = 0
      for (const [dx, dy] of [
        [1, 0],
        [0, 1],
        [1, 1],
        [1, -1],
      ] as const) {
        let run = 1
        for (const sign of [-1, 1]) {
          let step = 1
          for (;;) {
            const cx = p.x + dx * step * sign
            const cy = p.y + dy * step * sign
            if (cx < 0 || cy < 0 || cx >= SIZE || cy >= SIZE) break
            if (replay[idx(cx, cy)] !== side) break
            run += 1
            step += 1
          }
        }
        if (run >= 4) lines += 1
      }
      if (lines >= 2) st.winByDouble += 1
    }
  }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  if (s.length === 0) return null
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? (s[m] as number) : Math.round(((s[m - 1] as number) + (s[m] as number)) / 2)
}
const pctl = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length === 0 ? null : (s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))] as number)
}
const ms = (v: number | null) => (v == null ? '—' : v < 1000 ? `${v}ms` : `${(v / 1000).toFixed(1)}s`)
const pc = (n: number, d: number) => (d === 0 ? '—' : `${((n / d) * 100).toFixed(0)}%`)

const rows = ORDER.filter((id) => styles.has(id)).map((id) => styles.get(id) as Style)
const lines: string[] = []
const say = (s = '') => lines.push(s)

say('## 每一手在做什麼')
say()
say('依落子當下的盤面判定,不採用玩家自述。「攻」指下出四以上;「守」指拿掉')
say('對手四或活三的一端;「雙效」是同一手兩者兼具;「閒手」兩者皆非。')
say()
say('| 玩家 | 手數 | 攻 | 守 | 雙效 | 閒手 |')
say('| --- | --- | --- | --- | --- | --- |')
for (const s of rows) {
  say(
    `| ${SHORT[s.id]} | ${s.moves} | ${pc(s.attacks, s.moves)} | ${pc(s.blocks, s.moves)} | ` +
      `${pc(s.dual, s.moves)} | ${pc(s.quiet, s.moves)} |`,
  )
}
say()

say('## 看不看得見對手的威脅')
say()
say('盤上已有對手的四或活三時,這一手有沒有去處理。漏擋率是最能分辨棋力的單一數字。')
say()
say('| 玩家 | 遇到威脅次數 | 有擋 | 漏擋 | 漏擋率 |')
say('| --- | --- | --- | --- | --- |')
for (const s of rows) {
  const faced = s.answered + s.missed
  say(`| ${SHORT[s.id]} | ${faced} | ${s.answered} | ${s.missed} | **${pc(s.missed, faced)}** |`)
}
say()

say('## 思考時間')
say()
say('由伺服器統一量測。Sonnet、Antigravity、jev 的推論都在遠端,本機負載不影響;')
say('Chrome 座位在本機執行,其數字只反映本機開銷。')
say()
say('| 玩家 | 中位數 | 平均 | p90 | 最慢 |')
say('| --- | --- | --- | --- | --- |')
for (const s of rows) {
  say(
    `| ${SHORT[s.id]} | ${ms(median(s.thinking))} | ${ms(Math.round(mean(s.thinking) ?? 0))} | ` +
      `${ms(pctl(s.thinking, 0.9))} | ${ms(pctl(s.thinking, 1))} |`,
  )
}
say()

say('## 怎麼贏的')
say()
say('| 玩家 | 勝場 | 以雙重威脅收官 |')
say('| --- | --- | --- |')
for (const s of rows) {
  say(`| ${SHORT[s.id]} | ${s.wins} | ${s.winByDouble} |`)
}
say()

const body = lines.join('\n') + '\n'
if (OUT) {
  writeFileSync(OUT, body)
  console.error(`wrote ${OUT}`)
}
console.log(body)

/**
 * Does a wider shortlist measure the model, or just drown it?
 *
 *   node experiments/candidate-width.ts [repeats]
 *
 * A shortlisted seat picks from points the heuristic chose. Widening that list
 * moves the decision from the heuristic towards the model, so the wide end is
 * the honest end — but only if the model still answers well there. A model
 * that finds the winning move among 8 options and loses it among 224 has not
 * been measured more honestly; it has been measured at a width it cannot use.
 *
 * So this asks one question the board can mark objectively. Each position
 * below has exactly one correct move, checked here against the project's own
 * rules rather than asserted. The same position is then put to the model with
 * the candidate list padded out to several widths with legal but irrelevant
 * points, always including the correct one. Accuracy against width is the
 * answer; latency and the winner's probability come along because a decision
 * that is right but unconfident degrades differently from one that is wrong.
 *
 * Needs the relay running with a jev key (`GOMOKU_JEV_KEY`).
 */

import { EMPTY, BLACK, WHITE, SIZE, idx, coordLabel, moveLegality } from '../src/lib/rules.ts'
import type { Board, Side } from '../src/lib/rules.ts'
import { bestShape } from '../src/lib/ai/heuristic.ts'

const BASE = process.env['GOMOKU_URL'] ?? 'http://localhost:5273'
const UPSTREAM = process.env['JEV_BASE_URL'] ?? 'https://api.typesafe.ai/v1'
const REPEATS = Number(process.argv[2] ?? 2)
const COLS = 'ABCDEFGHJKLMNOP'
const WIDTHS = [8, 16, 32, 64, 128, 224]

const pointOf = (label: string): { x: number; y: number } => ({
  x: COLS.indexOf(label[0] ?? ''),
  y: SIZE - Number(label.slice(1)),
})

interface Position {
  name: string
  you: Side
  white: string[]
  black: string[]
  answer: string
  /** Set when the answer completes the opponent's five rather than your own. */
  fives?: 'opponent'
  why: string
}

/**
 * Three positions, each with one move that is correct for a reason the rules
 * can confirm: complete five, block the opponent's only completion, and
 * prefer your own five over blocking theirs.
 */
const POSITIONS: Position[] = [
  {
    name: 'win now',
    you: WHITE,
    white: ['E5', 'F5', 'G5', 'H5'],
    black: ['D5', 'E7', 'F8', 'G9'],
    answer: 'J5',
    why: 'white completes five at J5; D5 is blocked',
  },
  {
    name: 'block their five',
    you: WHITE,
    white: ['D5', 'E8', 'F9', 'G10'],
    black: ['E5', 'F5', 'G5', 'H5'],
    answer: 'J5',
    // The answer is correct because it is five for the OPPONENT, not for you.
    fives: 'opponent',
    why: 'black completes five at J5 unless white takes it',
  },
  {
    name: 'win rather than block',
    you: WHITE,
    white: ['E5', 'F5', 'G5', 'H5'],
    black: ['D5', 'K7', 'L7', 'M7', 'N7'],
    answer: 'J5',
    why: 'white has its own five at J5; blocking black at J7/P7 loses the race',
  },
]

const buildBoard = (pos: Position): Board => {
  const board = new Uint8Array(SIZE * SIZE).fill(EMPTY)
  for (const label of pos.white) {
    const { x, y } = pointOf(label)
    board[idx(x, y)] = WHITE
  }
  for (const label of pos.black) {
    const { x, y } = pointOf(label)
    board[idx(x, y)] = BLACK
  }
  return board
}

/** Refuse to run a position whose stated answer the rules do not agree with. */
for (const pos of POSITIONS) {
  const board = buildBoard(pos)
  const { x, y } = pointOf(pos.answer)
  if (board[idx(x, y)] !== EMPTY) throw new Error(`${pos.name}: answer ${pos.answer} is occupied`)
  const forWhom = pos.fives === 'opponent' ? (pos.you === WHITE ? BLACK : WHITE) : pos.you
  const shape = bestShape(board, x, y, forWhom, SIZE)
  if (shape !== 'five') {
    throw new Error(`${pos.name}: ${pos.answer} makes "${shape}" for ${pos.fives ?? 'self'}, not five`)
  }
  console.error(`checked  ${pos.name}: ${pos.answer} makes five for ${pos.fives ?? 'you'} — ${pos.why}`)
}

const legalPoints = (board: Board, color: Side): string[] => {
  const out: string[] = []
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      if (board[idx(x, y)] !== EMPTY) continue
      if (!moveLegality(board, x, y, color, 'free').legal) continue
      out.push(coordLabel(x, y))
    }
  }
  return out
}

/** The position as the relay is told it, in the words the model reads. */
interface PositionState {
  game: string
  rule_set: string
  board_size: string
  you_play: string
  your_stones: string
  opponent_stones: string
  objective: string
}

const describe = (board: Board, color: Side): PositionState => {
  const mine: string[] = []
  const theirs: string[] = []
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const cell = board[idx(x, y)]
      if (cell === color) mine.push(coordLabel(x, y))
      else if (cell !== EMPTY) theirs.push(coordLabel(x, y))
    }
  }
  return {
    game: 'gomoku',
    rule_set: 'free style (five or more in a row wins)',
    board_size: `${SIZE}x${SIZE}`,
    you_play: color === BLACK ? 'black' : 'white',
    your_stones: mine.join(' ') || '(none yet)',
    opponent_stones: theirs.join(' ') || '(none yet)',
    objective:
      'Get five of your stones in an unbroken row, column, or diagonal before the opponent does. Block the opponent when their threat is more urgent than yours.',
  }
}

/**
 * What comes back from the relay, as much of it as this script reads. Every
 * field is optional because the envelope is a response, not a promise: a
 * refusal upstream arrives in the same shape with the answer missing.
 */
interface JevAnswer {
  choice?: string | null
  probabilities?: Record<string, number>
}

interface JevEnvelope {
  ok?: boolean
  body?: { answers?: Record<string, JevAnswer> }
}

interface JevResult {
  ok: boolean
  choice: string | null
  probability: number | null
  pCorrect: number | null
  rankCorrect: number
  uniform: number | null
  returned: number
  ms: number
  bytes: number
}

async function askJev(state: PositionState, labels: string[], correctLabel: string): Promise<JevResult> {
  const criteria: Record<string, string> = {}
  for (const label of labels) criteria[label] = ''
  const started = Date.now()
  const response = await fetch(`${BASE}/api/jev`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      baseUrl: UPSTREAM,
      request: {
        state,
        model: 'jev-latest',
        questions: {
          move: {
            type: 'choice',
            instructions:
              'Which move should you play next? Weigh your own winning threats against the opponent’s.',
            criteria,
          },
        },
      },
    }),
  })
  const envelope = (await response.json()) as JevEnvelope
  const answer = envelope.body?.answers?.['move'] ?? {}
  const probabilities = answer.probabilities ?? {}
  const choice = answer.choice ?? null
  return {
    ok: envelope.ok === true,
    choice,
    probability: choice === null ? null : (probabilities[choice] ?? null),
    /*
     * What the model gave the right move, whether or not it picked it. This is
     * the cleaner signal: a model that still ranks the win highly but loses a
     * coin-flip against a distractor is degrading differently from one whose
     * probability on the win has collapsed into the noise.
     */
    pCorrect: probabilities[correctLabel] ?? null,
    /*
     * Where the right move sat in the model's own ranking. At the wide end the
     * argmax stops being informative: a distribution over 217 points can carry
     * real signal and still lose the top slot to a distractor, so the rank says
     * whether the model knows and the accuracy says whether the harness can
     * use what it knows.
     */
    rankCorrect: Object.entries(probabilities)
      .sort((a, b) => b[1] - a[1])
      .findIndex(([label]) => label === correctLabel),
    uniform: Object.keys(probabilities).length ? 1 / Object.keys(probabilities).length : null,
    returned: Object.keys(probabilities).length,
    ms: Date.now() - started,
    bytes: JSON.stringify(criteria).length,
  }
}

/**
 * Widen the list with legal but irrelevant points, keeping the answer in.
 *
 * The sets are nested: width N is the first N of one fixed ordering, so going
 * wider only ever adds options and never swaps them. An earlier version spread
 * the distractors evenly across the board at each width, which changed *which*
 * points were offered as well as how many — and the accuracy that came out of
 * it was reading the distractors, not the width. A strong-looking distractor
 * such as the point just past the end of your own four either was or was not
 * in the list depending on the stride.
 *
 * The ordering is shuffled once from a fixed seed rather than left in board
 * order, so the narrow widths are not all one corner of the board.
 */
const orderingFor = (answer: string, pool: string[], seed = 12345): string[] => {
  const rest = pool.filter((p) => p !== answer)
  let state = seed
  const random = (): number => {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    return state / 0x7fffffff
  }
  for (let i = rest.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    const high = rest[i]
    const low = rest[j]
    // Both indices are in range; the check is what `noUncheckedIndexedAccess`
    // asks for rather than a case that can happen.
    if (high === undefined || low === undefined) continue
    rest[i] = low
    rest[j] = high
  }
  return [answer, ...rest]
}

interface Row extends JevResult {
  pos: string
  width: number
  correct: boolean
}

const rows: Row[] = []
for (const pos of POSITIONS) {
  const board = buildBoard(pos)
  const state = describe(board, pos.you)
  const pool = legalPoints(board, pos.you)
  const ordering = orderingFor(pos.answer, pool)
  // The widest run is the whole legal move space, which is the ceiling the
  // board imposes; anything past it is not a wider question, just a shorter
  // board.
  const widths = [...WIDTHS.filter((w) => w < ordering.length), ordering.length]
  for (const width of widths) {
    const labels = ordering.slice(0, width)
    for (let r = 0; r < REPEATS; r += 1) {
      const got = await askJev(state, labels, pos.answer)
      rows.push({ pos: pos.name, width: labels.length, correct: got.choice === pos.answer, ...got })
      console.error(
        `  ${pos.name.padEnd(22)} width=${String(labels.length).padStart(3)} ` +
          `chose ${String(got.choice).padEnd(4)} ${got.choice === pos.answer ? 'OK ' : 'MISS'} ` +
          `p=${got.pCorrect == null ? '—' : got.pCorrect.toFixed(3)} rank=${got.rankCorrect} ${got.ms}ms`,
      )
    }
  }
}

console.log(
  '\n| Width | Calls | Picked it | Accuracy | Mean p(correct) | Uniform | Lift | Median rank of correct | Latency |',
)
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- |')
const seenWidths = [...new Set(rows.map((r) => r.width))].sort((a, b) => a - b)
for (const width of seenWidths) {
  const at = rows.filter((r) => r.width === width)
  if (at.length === 0) continue
  const ok = at.filter((r) => r.correct).length
  const ps = at.map((r) => r.pCorrect).filter((p) => p != null)
  const meanP = ps.length ? (ps.reduce((a, b) => a + b, 0) / ps.length).toFixed(3) : '—'
  const meanMs = Math.round(at.reduce((a, r) => a + r.ms, 0) / at.length)
  const ranks = at
    .map((r) => r.rankCorrect)
    .filter((r) => r != null && r >= 0)
    .sort((a, b) => a - b)
  const medRank = ranks[Math.floor(ranks.length / 2)] ?? '—'
  const uni = at[0]?.uniform ?? null
  const lift = uni && ps.length ? (Number(meanP) / uni).toFixed(1) + 'x' : '—'
  console.log(
    `| ${width} | ${at.length} | ${ok} | ${((ok / at.length) * 100).toFixed(0)}% | ${meanP} | ` +
      `${uni ? uni.toFixed(4) : '—'} | ${lift} | ${medRank} | ${meanMs}ms |`,
  )
}

console.log('\n| Position | ' + seenWidths.join(' | ') + ' |')
console.log('| --- |' + seenWidths.map(() => ' --- |').join(''))
for (const pos of POSITIONS) {
  const cells = seenWidths.map((w) => {
    const at = rows.filter((r) => r.pos === pos.name && r.width === w)
    if (at.length === 0) return 'n/a'
    return `${at.filter((r) => r.correct).length}/${at.length}`
  })
  console.log(`| ${pos.name} | ${cells.join(' | ')} |`)
}

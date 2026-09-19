/**
 * The code-only engines.
 *
 * Each is a different classical approach, so the shared expectations are what
 * matter: take a win when there is one, block a loss when there is one, never
 * produce a move the board would refuse, and come back inside their budget.
 */

import { BLACK, WHITE, createBoard, idx, moveLegality, makesFive } from '../src/lib/rules.ts'
import { ENGINES } from '../src/lib/ai/engines.ts'

let pass = 0
let fail = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  ok ? (pass += 1) : (fail += 1)
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}` +
      (ok ? '' : `\n      expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`),
  )
}
const truthy = (name, value, detail = '') => {
  value ? (pass += 1) : (fail += 1)
  console.log(`${value ? 'PASS' : 'FAIL'}  ${name}${value ? '' : `\n      ${detail}`}`)
}

const board = (stones) => {
  const b = createBoard()
  for (const [x, y, c] of stones) b[idx(x, y)] = c
  return b
}
const row = (y, xs, c) => xs.map((x) => [x, y, c])

// Keep the test quick: the engines are budget-driven, so shrink the budgets.
const OPTIONS = {
  greedy: undefined,
  minimax: { depth: 3, width: 8, budgetMs: 1500 },
  mcts: { budgetMs: 400 },
}

for (const engine of Object.values(ENGINES)) {
  const opts = OPTIONS[engine.id]

  // Four black stones in a row: the fifth wins outright.
  const winNow = board(row(7, [3, 4, 5, 6], BLACK))
  const win = engine.run(winNow, BLACK, 'free', opts)
  truthy(`${engine.name}: takes the win`, ['C8', 'H8'].includes(win.point), `played ${win.point}`)

  // White has four in a row; black must block or lose next move.
  const mustBlock = board([...row(7, [3, 4, 5, 6], WHITE), [9, 9, BLACK]])
  const block = engine.run(mustBlock, BLACK, 'free', opts)
  truthy(`${engine.name}: blocks an immediate loss`, ['C8', 'H8'].includes(block.point), `played ${block.point}`)

  // Renju forbids black a double three; no engine may offer one.
  const trap = board([...row(7, [5, 6], BLACK), [7, 5, BLACK], [7, 6, BLACK], [0, 0, WHITE]])
  const underRenju = engine.run(trap, BLACK, 'renju', opts)
  const legality = moveLegality(
    trap,
    'ABCDEFGHJKLMNOPQRSTUVWXYZ'.indexOf(underRenju.point[0]),
    15 - Number(underRenju.point.slice(1)),
    BLACK,
    'renju',
  )
  check(`${engine.name}: never offers a forbidden move`, legality.legal, true)

  // It reports what it did.
  truthy(`${engine.name}: reports a model name`, Boolean(win.telemetry.model))
  truthy(`${engine.name}: reports a ranking`, win.telemetry.ranked.length > 0)
}

// A full game between two engines finishes without an illegal move.
function playOut(blackEngine, whiteEngine, ruleSet = 'free') {
  const b = createBoard()
  let turn = BLACK
  for (let ply = 0; ply < 225; ply += 1) {
    const engine = turn === BLACK ? blackEngine : whiteEngine
    const move = engine.run(b, turn, ruleSet, OPTIONS[engine.id])
    if (!move) return { plies: ply, result: 'draw' }
    const x = 'ABCDEFGHJKLMNOPQRSTUVWXYZ'.indexOf(move.point[0])
    const y = 15 - Number(move.point.slice(1))
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

const game = playOut(ENGINES.greedy, ENGINES.minimax)
truthy(
  'greedy vs minimax plays to a finish with only legal moves',
  ['black', 'white', 'draw'].includes(game.result),
  `ended as ${game.result} after ${game.plies} plies`,
)
console.log(`      (${game.result} in ${game.plies} plies)`)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

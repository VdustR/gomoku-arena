import {
  BLACK,
  WHITE,
  createBoard,
  idx,
  moveLegality,
  resolveMove,
  forbiddenReason,
} from '../src/lib/rules.ts'

let pass = 0,
  fail = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  ok ? pass++ : fail++
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`,
  )
}
const board = (stones) => {
  const b = createBoard()
  for (const [x, y, c] of stones) b[idx(x, y)] = c
  return b
}
const row = (y, xs, c) => xs.map((x) => [x, y, c])

// 1. Free style: five in a row wins.
check(
  'free: black five wins',
  resolveMove(board(row(7, [3, 4, 5, 6], BLACK)), 7, 7, BLACK, 'free').status,
  'win',
)

// 2. Free style: overline also wins (no restriction).
check(
  'free: black overline wins',
  resolveMove(board(row(7, [3, 4, 5, 6, 7], BLACK)), 8, 7, BLACK, 'free').status,
  'win',
)

// 3. Renju: black overline is forbidden, not a win.
check(
  'renju: black overline forbidden',
  moveLegality(board(row(7, [3, 4, 5, 6, 7], BLACK)), 8, 7, BLACK, 'renju').reason,
  'overline',
)

// 4. Renju: white overline still wins.
check(
  'renju: white overline wins',
  resolveMove(board(row(7, [3, 4, 5, 6, 7], WHITE)), 8, 7, WHITE, 'renju').status,
  'win',
)

// 5. Renju: black exact five is legal and wins.
check(
  'renju: black exact five legal',
  moveLegality(board(row(7, [3, 4, 5, 6], BLACK)), 7, 7, BLACK, 'renju').legal,
  true,
)
check(
  'renju: black exact five wins',
  resolveMove(board(row(7, [3, 4, 5, 6], BLACK)), 7, 7, BLACK, 'renju').status,
  'win',
)

// 6. Renju: double three. Two open threes crossing at (7,7).
//    Horizontal .  X X _ X X .  -> playing centre makes an open three each way.
const dt3 = board([...row(7, [5, 6], BLACK), [7, 5, BLACK], [7, 6, BLACK]])
check('renju: double three forbidden', forbiddenReason(dt3, 7, 7), 'double-three')

// 7. Renju: a single open three is fine.
const one3 = board(row(7, [5, 6], BLACK))
check('renju: single open three legal', forbiddenReason(one3, 7, 7), null)

// 8. Renju: double four — two fours crossing at (7,7).
const dt4 = board([...row(7, [4, 5, 6], BLACK), [7, 4, BLACK], [7, 5, BLACK], [7, 6, BLACK]])
check('renju: double four forbidden', forbiddenReason(dt4, 7, 7), 'double-four')

// 9. Renju: five outranks double four — same shape, but the move completes five.
const fiveWins = board([...row(7, [3, 4, 5, 6], BLACK), [7, 4, BLACK], [7, 5, BLACK], [7, 6, BLACK]])
check('renju: five outranks double four', forbiddenReason(fiveWins, 7, 7), null)

// 10. Renju restrictions never apply to white.
check(
  'renju: white double three legal',
  moveLegality(board([...row(7, [5, 6], WHITE), [7, 5, WHITE], [7, 6, WHITE]]), 7, 7, WHITE, 'renju').legal,
  true,
)

// 11. Occupied points are rejected.
check('occupied point rejected', moveLegality(board([[7, 7, BLACK]]), 7, 7, WHITE, 'free').reason, 'occupied')

// 12. Edge of board does not wrap around.
check(
  'no wrap at right edge',
  resolveMove(
    board([
      [11, 0, BLACK],
      [12, 0, BLACK],
      [13, 0, BLACK],
      [14, 0, BLACK],
    ]),
    10,
    0,
    BLACK,
    'free',
  ).status,
  'win',
)
check(
  'no wrap across rows',
  resolveMove(
    board([
      [13, 0, BLACK],
      [14, 0, BLACK],
      [0, 1, BLACK],
      [1, 1, BLACK],
    ]),
    2,
    1,
    BLACK,
    'free',
  ).status,
  'playing',
)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

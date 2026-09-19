/**
 * Board rules for free-style gomoku and renju.
 *
 * Free style: first player to get five or more in a row wins.
 *
 * Renju: the standard tournament rule set. Free-style gomoku on 15x15 is a
 * proven first-player win, so renju restricts black only. Black may not play a
 * move that creates an overline (six or more), two fours, or two open threes;
 * such a move loses the game immediately. A move that makes exactly five wins
 * outright and is never forbidden, even when it also matches one of those
 * shapes. White plays unrestricted and wins with five or more.
 */

export const SIZE = 15
export const EMPTY = 0
export const BLACK = 1
export const WHITE = 2

export const RULE_SETS = {
  free: {
    id: 'free',
    name: 'Free style',
    blurb: 'Five or more in a row wins. No restrictions on either player.',
  },
  renju: {
    id: 'renju',
    name: 'Renju',
    blurb: 'Tournament rules. Black loses on an overline, a double four, or a double three.',
  },
}

/** The four axes a line can run along: horizontal, vertical, and both diagonals. */
const DIRECTIONS = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
]

export function createBoard(size = SIZE) {
  return new Uint8Array(size * size)
}

export const idx = (x, y, size = SIZE) => y * size + x
export const inBounds = (x, y, size = SIZE) => x >= 0 && y >= 0 && x < size && y < size

export function coordLabel(x, y, size = SIZE) {
  // Column letters skip I, the convention board games inherited from go.
  const letters = 'ABCDEFGHJKLMNOPQRSTUVWXYZ'
  return `${letters[x]}${size - y}`
}

/**
 * Half-width of the window examined along an axis. Five reaches far enough to
 * see a run of six, which renju needs in order to tell a five from an overline.
 */
const RADIUS = 5

/**
 * Cells along one axis through (x, y), from -RADIUS to +RADIUS, with the move
 * applied. Off-board cells read as the opposing color so they block a run the
 * same way a stone would.
 */
function lineWindow(board, x, y, dx, dy, color, size) {
  const cells = []
  for (let step = -RADIUS; step <= RADIUS; step += 1) {
    const cx = x + dx * step
    const cy = y + dy * step
    if (step === 0) {
      cells.push(color)
    } else if (!inBounds(cx, cy, size)) {
      cells.push(color === BLACK ? WHITE : BLACK)
    } else {
      cells.push(board[idx(cx, cy, size)])
    }
  }
  return cells
}

/** Longest unbroken run of `color` through the centre of the window. */
function runThroughCentre(cells, color) {
  let length = 1
  for (let i = RADIUS - 1; i >= 0 && cells[i] === color; i -= 1) length += 1
  for (let i = RADIUS + 1; i < cells.length && cells[i] === color; i += 1) length += 1
  return length
}

/** Runs formed at (x, y) along each axis, assuming `color` was just played. */
function runsAt(board, x, y, color, size) {
  return DIRECTIONS.map(([dx, dy]) => runThroughCentre(lineWindow(board, x, y, dx, dy, color, size), color))
}

export function makesFive(board, x, y, color, { exact = false, size = SIZE } = {}) {
  return runsAt(board, x, y, color, size).some((run) => (exact ? run === 5 : run >= 5))
}

export function makesOverline(board, x, y, color, size = SIZE) {
  return runsAt(board, x, y, color, size).some((run) => run >= 6)
}

/** Empty points within four cells of (x, y) along one axis. */
function lineCandidates(board, x, y, dx, dy, size) {
  const points = []
  for (let step = -4; step <= 4; step += 1) {
    if (step === 0) continue
    const cx = x + dx * step
    const cy = y + dy * step
    if (inBounds(cx, cy, size) && board[idx(cx, cy, size)] === EMPTY) points.push([cx, cy])
  }
  return points
}

/**
 * Does placing black at (x, y) create a four along this axis — a run of four
 * that one more stone turns into exactly five?
 */
function isFourOnAxis(board, x, y, dx, dy, size) {
  const run = runThroughCentre(lineWindow(board, x, y, dx, dy, BLACK, size), BLACK)
  if (run !== 4) return false
  const probe = board.slice()
  probe[idx(x, y, size)] = BLACK
  return lineCandidates(probe, x, y, dx, dy, size).some(([cx, cy]) => {
    const next = probe.slice()
    next[idx(cx, cy, size)] = BLACK
    const length = runThroughCentre(lineWindow(probe, cx, cy, dx, dy, BLACK, size), BLACK)
    return length === 5
  })
}

/** An open four: four in a row that can be completed to five from either end. */
function isOpenFourOnAxis(board, x, y, dx, dy, size) {
  const cells = lineWindow(board, x, y, dx, dy, BLACK, size)
  if (runThroughCentre(cells, BLACK) !== 4) return false
  let low = RADIUS
  let high = RADIUS
  while (cells[low - 1] === BLACK) low -= 1
  while (cells[high + 1] === BLACK) high += 1
  return cells[low - 1] === EMPTY && cells[high + 1] === EMPTY
}

/**
 * An open three: a three that one legal black stone turns into an open four.
 * The follow-up move must itself be legal, which is why this recurses back
 * through the forbidden-move check.
 */
function isOpenThreeOnAxis(board, x, y, dx, dy, size, depth) {
  const run = runThroughCentre(lineWindow(board, x, y, dx, dy, BLACK, size), BLACK)
  if (run !== 3) return false
  const probe = board.slice()
  probe[idx(x, y, size)] = BLACK
  return lineCandidates(probe, x, y, dx, dy, size).some(([cx, cy]) => {
    if (!isOpenFourOnAxis(probe, cx, cy, dx, dy, size)) return false
    if (depth <= 0) return true
    return forbiddenReason(probe, cx, cy, { size, depth: depth - 1 }) === null
  })
}

/**
 * Why renju forbids black from playing (x, y), or null when the move is legal.
 * Assumes (x, y) is empty and it is black's turn.
 */
export function forbiddenReason(board, x, y, { size = SIZE, depth = 3 } = {}) {
  // Five wins outright and outranks every restriction below it.
  if (makesFive(board, x, y, BLACK, { exact: true, size })) return null
  if (makesOverline(board, x, y, BLACK, size)) return 'overline'

  let fours = 0
  let openThrees = 0
  for (const [dx, dy] of DIRECTIONS) {
    if (isFourOnAxis(board, x, y, dx, dy, size)) fours += 1
    if (isOpenThreeOnAxis(board, x, y, dx, dy, size, depth)) openThrees += 1
  }
  if (fours >= 2) return 'double-four'
  if (openThrees >= 2) return 'double-three'
  return null
}

export const FORBIDDEN_COPY = {
  overline: { label: 'Overline', detail: 'Six or more black stones in a row.' },
  'double-four': { label: 'Double four', detail: 'This move opens two fours at once.' },
  'double-three': { label: 'Double three', detail: 'This move opens two threes at once.' },
}

/**
 * Is this move legal for `color` right now? Renju restrictions apply to black
 * only; every other case is legal as long as the point is empty.
 */
export function moveLegality(board, x, y, color, ruleSet, size = SIZE) {
  if (!inBounds(x, y, size)) return { legal: false, reason: 'off-board' }
  if (board[idx(x, y, size)] !== EMPTY) return { legal: false, reason: 'occupied' }
  if (ruleSet !== 'renju' || color !== BLACK) return { legal: true, reason: null }
  const forbidden = forbiddenReason(board, x, y, { size })
  return forbidden ? { legal: false, reason: forbidden } : { legal: true, reason: null }
}

/**
 * The outcome after `color` plays (x, y). Renju gives black exactly five;
 * an overline is handled by moveLegality before the move is ever applied.
 */
export function resolveMove(board, x, y, color, ruleSet, size = SIZE) {
  const exact = ruleSet === 'renju' && color === BLACK
  if (makesFive(board, x, y, color, { exact, size })) return { status: 'win', winner: color }
  const next = board.slice()
  next[idx(x, y, size)] = color
  if (next.every((cell) => cell !== EMPTY)) return { status: 'draw', winner: null }
  return { status: 'playing', winner: null }
}

/** The stones making up the winning run, for highlighting it on the board. */
export function winningLine(board, x, y, color, size = SIZE) {
  for (const [dx, dy] of DIRECTIONS) {
    const stones = [[x, y]]
    for (const sign of [-1, 1]) {
      let step = 1
      for (;;) {
        const cx = x + dx * step * sign
        const cy = y + dy * step * sign
        if (!inBounds(cx, cy, size) || board[idx(cx, cy, size)] !== color) break
        stones.push([cx, cy])
        step += 1
      }
    }
    if (stones.length >= 5) return stones
  }
  return []
}

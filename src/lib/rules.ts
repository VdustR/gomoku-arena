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
 *
 * Typed first, because it is the smallest module, the purest, and the one
 * everything else depends on. Two things the types carry that the prose used
 * to carry alone: a stone is one of three values rather than any number, and
 * `board[idx(x, y)]` is `Stone | undefined`, which is the honest type of
 * indexing a flat array with arithmetic.
 */

export const SIZE = 15
export const EMPTY = 0
export const BLACK = 1
export const WHITE = 2

/** A point on the board holds one of exactly three things. */
export type Stone = typeof EMPTY | typeof BLACK | typeof WHITE
/** A side. Not every `Stone` is one: `EMPTY` cannot play a move. */
export type Side = typeof BLACK | typeof WHITE
export type Board = Uint8Array

export type RuleSetId = 'free' | 'renju'

export interface RuleSet {
  id: RuleSetId
  name: string
  blurb: string
}

export const RULE_SETS: Record<RuleSetId, RuleSet> = {
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

/** A point, as the board's own coordinates. */
export type Point = readonly [x: number, y: number]

/** The four axes a line can run along: horizontal, vertical, and both diagonals. */
const DIRECTIONS: readonly Point[] = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
]

export function createBoard(size: number = SIZE): Board {
  return new Uint8Array(size * size)
}

export const idx = (x: number, y: number, size: number = SIZE): number => y * size + x
export const inBounds = (x: number, y: number, size: number = SIZE): boolean =>
  x >= 0 && y >= 0 && x < size && y < size

/** Column letters skip I, the convention board games inherited from go. */
const LETTERS = 'ABCDEFGHJKLMNOPQRSTUVWXYZ'

export function coordLabel(x: number, y: number, size: number = SIZE): string {
  return `${LETTERS[x] ?? '?'}${size - y}`
}

/**
 * Read a point.
 *
 * `noUncheckedIndexedAccess` makes `board[i]` `number | undefined`, which is
 * the truth: nothing stops arithmetic producing an index past the end. Off the
 * board reads as empty, which is what every caller here already assumed.
 */
const at = (board: Board, i: number): Stone => (board[i] ?? EMPTY) as Stone

export const other = (color: Side): Side => (color === BLACK ? WHITE : BLACK)

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
function lineWindow(
  board: Board,
  x: number,
  y: number,
  dx: number,
  dy: number,
  color: Side,
  size: number,
): Stone[] {
  const cells: Stone[] = []
  for (let step = -RADIUS; step <= RADIUS; step += 1) {
    const cx = x + dx * step
    const cy = y + dy * step
    if (step === 0) {
      cells.push(color)
    } else if (!inBounds(cx, cy, size)) {
      cells.push(other(color))
    } else {
      cells.push(at(board, idx(cx, cy, size)))
    }
  }
  return cells
}

/** Longest unbroken run of `color` through the centre of the window. */
function runThroughCentre(cells: readonly Stone[], color: Side): number {
  let length = 1
  for (let i = RADIUS - 1; i >= 0 && cells[i] === color; i -= 1) length += 1
  for (let i = RADIUS + 1; i < cells.length && cells[i] === color; i += 1) length += 1
  return length
}

/** Runs formed at (x, y) along each axis, assuming `color` was just played. */
function runsAt(board: Board, x: number, y: number, color: Side, size: number): number[] {
  return DIRECTIONS.map(([dx, dy]) => runThroughCentre(lineWindow(board, x, y, dx, dy, color, size), color))
}

export interface FiveOptions {
  /** Renju gives black exactly five; an overline is a separate, losing shape. */
  exact?: boolean
  size?: number
}

export function makesFive(
  board: Board,
  x: number,
  y: number,
  color: Side,
  { exact = false, size = SIZE }: FiveOptions = {},
): boolean {
  return runsAt(board, x, y, color, size).some((run) => (exact ? run === 5 : run >= 5))
}

export function makesOverline(board: Board, x: number, y: number, color: Side, size: number = SIZE): boolean {
  return runsAt(board, x, y, color, size).some((run) => run >= 6)
}

/** Empty points within four cells of (x, y) along one axis. */
function lineCandidates(board: Board, x: number, y: number, dx: number, dy: number, size: number): Point[] {
  const points: Point[] = []
  for (let step = -4; step <= 4; step += 1) {
    if (step === 0) continue
    const cx = x + dx * step
    const cy = y + dy * step
    if (inBounds(cx, cy, size) && at(board, idx(cx, cy, size)) === EMPTY) points.push([cx, cy])
  }
  return points
}

/**
 * Does placing black at (x, y) create a four along this axis — a run of four
 * that one more stone turns into exactly five?
 */
function isFourOnAxis(board: Board, x: number, y: number, dx: number, dy: number, size: number): boolean {
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
function isOpenFourOnAxis(board: Board, x: number, y: number, dx: number, dy: number, size: number): boolean {
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
function isOpenThreeOnAxis(
  board: Board,
  x: number,
  y: number,
  dx: number,
  dy: number,
  size: number,
  depth: number,
): boolean {
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

/** Why renju forbids a black move. Each one loses the game if played. */
export type ForbiddenReason = 'overline' | 'double-four' | 'double-three'

export interface ForbiddenOptions {
  size?: number
  depth?: number
}

/**
 * Why renju forbids black from playing (x, y), or null when the move is legal.
 * Assumes (x, y) is empty and it is black's turn.
 */
export function forbiddenReason(
  board: Board,
  x: number,
  y: number,
  { size = SIZE, depth = 3 }: ForbiddenOptions = {},
): ForbiddenReason | null {
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

export interface ForbiddenCopy {
  label: string
  detail: string
}

export const FORBIDDEN_COPY: Record<ForbiddenReason, ForbiddenCopy> = {
  overline: { label: 'Overline', detail: 'Six or more black stones in a row.' },
  'double-four': { label: 'Double four', detail: 'This move opens two fours at once.' },
  'double-three': { label: 'Double three', detail: 'This move opens two threes at once.' },
}

/** Everything the board can refuse, whatever the rule set. */
export type IllegalReason = 'off-board' | 'occupied' | ForbiddenReason

export type Legality = { legal: true; reason: null } | { legal: false; reason: IllegalReason }

/**
 * Is this move legal for `color` right now? Renju restrictions apply to black
 * only; every other case is legal as long as the point is empty.
 */
export function moveLegality(
  board: Board,
  x: number,
  y: number,
  color: Side,
  ruleSet: RuleSetId,
  size: number = SIZE,
): Legality {
  if (!inBounds(x, y, size)) return { legal: false, reason: 'off-board' }
  if (at(board, idx(x, y, size)) !== EMPTY) return { legal: false, reason: 'occupied' }
  if (ruleSet !== 'renju' || color !== BLACK) return { legal: true, reason: null }
  const forbidden = forbiddenReason(board, x, y, { size })
  return forbidden ? { legal: false, reason: forbidden } : { legal: true, reason: null }
}

/** How a game stands once the moves have been replayed. A hold is not here. */
export type Outcome =
  | { status: 'win'; winner: Side }
  | { status: 'draw'; winner: null }
  | { status: 'playing'; winner: null }

/**
 * The outcome after `color` plays (x, y). Renju gives black exactly five;
 * an overline is handled by moveLegality before the move is ever applied.
 */
export function resolveMove(
  board: Board,
  x: number,
  y: number,
  color: Side,
  ruleSet: RuleSetId,
  size: number = SIZE,
): Outcome {
  const exact = ruleSet === 'renju' && color === BLACK
  if (makesFive(board, x, y, color, { exact, size })) return { status: 'win', winner: color }
  const next = board.slice()
  next[idx(x, y, size)] = color
  if (next.every((cell) => cell !== EMPTY)) return { status: 'draw', winner: null }
  return { status: 'playing', winner: null }
}

/** The stones making up the winning run, for highlighting it on the board. */
export function winningLine(board: Board, x: number, y: number, color: Side, size: number = SIZE): Point[] {
  for (const [dx, dy] of DIRECTIONS) {
    const stones: Point[] = [[x, y]]
    for (const sign of [-1, 1]) {
      let step = 1
      for (;;) {
        const cx = x + dx * step * sign
        const cy = y + dy * step * sign
        if (!inBounds(cx, cy, size) || at(board, idx(cx, cy, size)) !== color) break
        stones.push([cx, cy])
        step += 1
      }
    }
    if (stones.length >= 5) return stones
  }
  return []
}

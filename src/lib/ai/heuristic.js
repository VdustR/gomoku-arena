/**
 * Candidate generation.
 *
 * No model is asked to invent a coordinate. Code finds the moves worth
 * considering and describes what each one does; the model's whole job is to
 * pick one of them. That keeps an illegal or nonsensical move off the board
 * no matter how the provider behaves, and gives every provider — an on-device
 * model, a chat model, a typed decision model — the same shortlist to judge.
 */

import { BLACK, WHITE, EMPTY, SIZE, idx, inBounds, moveLegality, coordLabel } from '../rules.js'
import { config } from '../config.js'

export const DIRECTIONS = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
]

/** How a run of stones reads once both of its ends are accounted for. */
export const SHAPE_SCORES = {
  five: 1_000_000,
  'open-four': 100_000,
  four: 12_000,
  'open-three': 10_000,
  three: 1_200,
  'open-two': 400,
  two: 80,
  one: 10,
  none: 0,
}

const SHAPE_COPY = {
  five: 'makes five',
  'open-four': 'makes an open four',
  four: 'makes a four',
  'open-three': 'makes an open three',
  three: 'makes a three',
  'open-two': 'makes an open two',
  two: 'makes a two',
  one: 'places a lone stone',
  none: 'develops nothing',
}

/** Classify the run through (x, y) along one axis after `color` plays there. */
export function shapeOnAxis(board, x, y, dx, dy, color, size) {
  let run = 1
  let openEnds = 0
  for (const sign of [-1, 1]) {
    let step = 1
    for (;;) {
      const cx = x + dx * step * sign
      const cy = y + dy * step * sign
      if (!inBounds(cx, cy, size)) break
      const cell = board[idx(cx, cy, size)]
      if (cell === color) {
        run += 1
        step += 1
        continue
      }
      if (cell === EMPTY) openEnds += 1
      break
    }
  }
  if (run >= 5) return 'five'
  if (run === 4) return openEnds >= 2 ? 'open-four' : openEnds === 1 ? 'four' : 'none'
  if (run === 3) return openEnds >= 2 ? 'open-three' : openEnds === 1 ? 'three' : 'none'
  if (run === 2) return openEnds >= 2 ? 'open-two' : openEnds === 1 ? 'two' : 'none'
  return openEnds >= 1 ? 'one' : 'none'
}

/** The strongest shape (x, y) creates for `color`, across all four axes. */
export function bestShape(board, x, y, color, size) {
  let best = 'none'
  for (const [dx, dy] of DIRECTIONS) {
    const shape = shapeOnAxis(board, x, y, dx, dy, color, size)
    if (SHAPE_SCORES[shape] > SHAPE_SCORES[best]) best = shape
  }
  return best
}

/** Empty points within `reach` of an existing stone — everywhere else is noise. */
export function relevantPoints(board, size, reach = 2) {
  const seen = new Set()
  const points = []
  let occupied = false
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (board[idx(x, y, size)] === EMPTY) continue
      occupied = true
      for (let oy = -reach; oy <= reach; oy += 1) {
        for (let ox = -reach; ox <= reach; ox += 1) {
          const cx = x + ox
          const cy = y + oy
          if (!inBounds(cx, cy, size) || board[idx(cx, cy, size)] !== EMPTY) continue
          const key = idx(cx, cy, size)
          if (seen.has(key)) continue
          seen.add(key)
          points.push([cx, cy])
        }
      }
    }
  }
  if (!occupied) {
    const centre = Math.floor(size / 2)
    return [[centre, centre]]
  }
  return points
}

/**
 * The shortlist a provider chooses from, strongest first. Each entry carries
 * plain-language reasons so a model can judge it without seeing the grid.
 */
export function candidateMoves(board, color, ruleSet, { limit = config.candidateLimit, size = SIZE } = {}) {
  const opponent = color === BLACK ? WHITE : BLACK
  const scored = []

  for (const [x, y] of relevantPoints(board, size)) {
    const legality = moveLegality(board, x, y, color, ruleSet, size)
    if (!legality.legal) continue

    const attack = bestShape(board, x, y, color, size)
    const defend = bestShape(board, x, y, opponent, size)
    // Defence is worth slightly less than the same shape played as attack,
    // so a winning move is never traded for a block.
    const score = SHAPE_SCORES[attack] + SHAPE_SCORES[defend] * 0.85

    const reasons = []
    if (attack !== 'none' && attack !== 'one') reasons.push(SHAPE_COPY[attack])
    if (SHAPE_SCORES[defend] >= SHAPE_SCORES['open-three']) {
      reasons.push(`blocks the opponent's ${defend.replace('-', ' ')}`)
    }
    if (reasons.length === 0) reasons.push('extends your position quietly')

    scored.push({
      x,
      y,
      label: coordLabel(x, y, size),
      attack,
      defend,
      score,
      rationale: reasons.join(' and '),
    })
  }

  scored.sort((a, b) => b.score - a.score || a.y - b.y || a.x - b.x)

  // Always keep a move that wins outright or stops an immediate loss, even
  // when the shortlist is short.
  const decisive = scored.find((move) => move.attack === 'five')
  const urgent = scored.find((move) => move.defend === 'five')
  const shortlist = scored.slice(0, limit)
  for (const must of [decisive, urgent]) {
    if (must && !shortlist.includes(must)) shortlist.unshift(must)
  }
  return shortlist.slice(0, Math.max(limit, 2))
}

/** The offline opponent: take the top-scoring candidate. */
export function heuristicPick(candidates) {
  return candidates[0] ?? null
}

/** A compact, model-readable description of the position. */
export function describePosition(board, color, ruleSet, size = SIZE) {
  const mine = []
  const theirs = []
  const opponent = color === BLACK ? WHITE : BLACK
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const cell = board[idx(x, y, size)]
      if (cell === color) mine.push(coordLabel(x, y, size))
      else if (cell === opponent) theirs.push(coordLabel(x, y, size))
    }
  }
  return {
    game: 'gomoku',
    rule_set: ruleSet === 'renju' ? 'renju (black may not play an overline, double four, or double three)' : 'free style (five or more in a row wins)',
    board_size: `${size}x${size}`,
    you_play: color === BLACK ? 'black' : 'white',
    your_stones: mine.length ? mine.join(' ') : '(none yet)',
    opponent_stones: theirs.length ? theirs.join(' ') : '(none yet)',
    objective: 'Get five of your stones in an unbroken row, column, or diagonal before the opponent does. Block the opponent when their threat is more urgent than yours.',
  }
}

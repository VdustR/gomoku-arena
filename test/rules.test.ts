import { describe, expect, it } from 'vitest'
import {
  BLACK,
  WHITE,
  createBoard,
  idx,
  moveLegality,
  resolveMove,
  forbiddenReason,
} from '../src/lib/rules.ts'
import type { Board, Side, Stone } from '../src/lib/rules.ts'

type Placement = [x: number, y: number, stone: Stone]

const board = (stones: Placement[]): Board => {
  const b = createBoard()
  for (const [x, y, c] of stones) b[idx(x, y)] = c
  return b
}
const row = (y: number, xs: number[], c: Side): Placement[] => xs.map((x) => [x, y, c])

describe('free style', () => {
  it('five in a row wins', () => {
    expect(resolveMove(board(row(7, [3, 4, 5, 6], BLACK)), 7, 7, BLACK, 'free').status).toBe('win')
  })

  it('an overline wins too, because nothing is restricted', () => {
    expect(resolveMove(board(row(7, [3, 4, 5, 6, 7], BLACK)), 8, 7, BLACK, 'free').status).toBe('win')
  })
})

describe('renju restricts black only', () => {
  it('black may not play an overline', () => {
    expect(moveLegality(board(row(7, [3, 4, 5, 6, 7], BLACK)), 8, 7, BLACK, 'renju').reason).toBe('overline')
  })

  it('white may, and it wins', () => {
    expect(resolveMove(board(row(7, [3, 4, 5, 6, 7], WHITE)), 8, 7, WHITE, 'renju').status).toBe('win')
  })

  it('black may play an exact five', () => {
    expect(moveLegality(board(row(7, [3, 4, 5, 6], BLACK)), 7, 7, BLACK, 'renju').legal).toBe(true)
    expect(resolveMove(board(row(7, [3, 4, 5, 6], BLACK)), 7, 7, BLACK, 'renju').status).toBe('win')
  })

  it('black may not make two open threes at once', () => {
    // Horizontal . X X _ X X . — playing the centre makes an open three each way.
    const dt3 = board([...row(7, [5, 6], BLACK), [7, 5, BLACK], [7, 6, BLACK]])
    expect(forbiddenReason(dt3, 7, 7)).toBe('double-three')
  })

  it('but one open three is fine', () => {
    expect(forbiddenReason(board(row(7, [5, 6], BLACK)), 7, 7)).toBe(null)
  })

  it('black may not make two fours at once', () => {
    const dt4 = board([...row(7, [4, 5, 6], BLACK), [7, 4, BLACK], [7, 5, BLACK], [7, 6, BLACK]])
    expect(forbiddenReason(dt4, 7, 7)).toBe('double-four')
  })

  it('five outranks a double four: the same shape, but the move completes five', () => {
    const fiveWins = board([...row(7, [3, 4, 5, 6], BLACK), [7, 4, BLACK], [7, 5, BLACK], [7, 6, BLACK]])
    expect(forbiddenReason(fiveWins, 7, 7)).toBe(null)
  })

  it('none of it applies to white', () => {
    const shape = board([...row(7, [5, 6], WHITE), [7, 5, WHITE], [7, 6, WHITE]])
    expect(moveLegality(shape, 7, 7, WHITE, 'renju').legal).toBe(true)
  })
})

describe('the board itself', () => {
  it('refuses an occupied point', () => {
    expect(moveLegality(board([[7, 7, BLACK]]), 7, 7, WHITE, 'free').reason).toBe('occupied')
  })

  it('counts a run that ends at the right edge', () => {
    const stones: Placement[] = [
      [11, 0, BLACK],
      [12, 0, BLACK],
      [13, 0, BLACK],
      [14, 0, BLACK],
    ]
    expect(resolveMove(board(stones), 10, 0, BLACK, 'free').status).toBe('win')
  })

  it('does not wrap a run from one row into the next', () => {
    const stones: Placement[] = [
      [13, 0, BLACK],
      [14, 0, BLACK],
      [0, 1, BLACK],
      [1, 1, BLACK],
    ]
    expect(resolveMove(board(stones), 2, 1, BLACK, 'free').status).toBe('playing')
  })
})

/**
 * A model can ignore a response constraint, answer in prose, or prepend a
 * status line. Reading a usable index out of whatever came back is what keeps
 * a formatting quirk from ending the turn.
 */

import { describe, expect, it } from 'vitest'
import { parseChoiceIndex } from '../src/lib/ai/providers.ts'

describe('reading a choice out of whatever the model said', () => {
  it('takes a constrained JSON object', () => {
    expect(parseChoiceIndex('{"choice": 2}', 8)).toBe(2)
  })

  it('takes a bare JSON number', () => {
    expect(parseChoiceIndex('3', 8)).toBe(3)
  })

  it('finds a number inside prose', () => {
    expect(parseChoiceIndex('I choose move 5 because it blocks.', 8)).toBe(5)
  })

  it('sees past a status line before the JSON', () => {
    expect(parseChoiceIndex('On-device model ready\n{"choice": 1}', 8)).toBe(1)
  })

  it('treats index zero as a real answer rather than as absent', () => {
    expect(parseChoiceIndex('{"choice": 0}', 8)).toBe(0)
  })

  it('sees past code fences', () => {
    expect(parseChoiceIndex('```json\n{"choice": 4}\n```', 8)).toBe(4)
  })

  it('falls past an out-of-range JSON value to a usable number', () => {
    expect(parseChoiceIndex('{"choice": 99} or 6', 8)).toBe(6)
  })
})

describe('what it refuses rather than guessing at', () => {
  it('throws on prose with no number', () => {
    expect(() => parseChoiceIndex('On-device something went wrong', 8)).toThrow()
  })

  it('throws when every number is out of range', () => {
    expect(() => parseChoiceIndex('42', 8)).toThrow()
  })

  it('throws on an empty reply', () => {
    expect(() => parseChoiceIndex('', 8)).toThrow()
  })
})

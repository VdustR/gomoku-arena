/**
 * Build-time configuration.
 *
 * The readers here decide what every default actually becomes, and an unset
 * variable is the common case — `Number('')` is 0, so a reader that parses
 * before checking for "unset" silently clamps every default to its minimum.
 */

/*
 * The readers are imported, not lifted out of the file's source.
 *
 * This suite used to slice them out with `indexOf` and re-evaluate them,
 * which tested a copy rather than the code that ships and depended on the
 * module staying plain JavaScript and keeping its declarations in one order.
 */
import { describe, expect, it } from 'vitest'
import { text, flag, count, oneOf } from '../src/lib/config.ts'

describe('count', () => {
  const range = { min: 2, max: 6 }

  it('falls back when the variable is unset, empty or blank', () => {
    expect(count(undefined, 4, range)).toBe(4)
    expect(count('', 4, range)).toBe(4)
    expect(count('   ', 4, range)).toBe(4)
  })

  it('honours a real zero rather than reading it as absent', () => {
    expect(count('0', 260, { min: 0, max: 5000 })).toBe(0)
  })

  it('uses a value inside the range', () => {
    expect(count('5', 4, range)).toBe(5)
  })

  it('clamps above and below the range', () => {
    expect(count('99', 4, range)).toBe(6)
    expect(count('1', 4, range)).toBe(2)
  })

  it('falls back on nonsense and truncates a fraction', () => {
    expect(count('deep', 4, range)).toBe(4)
    expect(count('4.9', 2, range)).toBe(4)
  })
})

describe('text', () => {
  it('falls back when unset or blank', () => {
    expect(text(undefined, 'https://example.com')).toBe('https://example.com')
    expect(text('  ', 'https://example.com')).toBe('https://example.com')
  })

  it('trims a value it keeps', () => {
    expect(text('  hi  ', 'x')).toBe('hi')
  })
})

describe('flag', () => {
  it('falls back when unset or empty', () => {
    expect(flag(undefined, true)).toBe(true)
    expect(flag('', true)).toBe(true)
  })

  it('honours an explicit false', () => {
    expect(flag('false', true)).toBe(false)
  })

  it('reads yes and 1 as true', () => {
    expect(flag('yes', false)).toBe(true)
    expect(flag('1', false)).toBe(true)
  })
})

describe('oneOf', () => {
  const allowed = ['free', 'renju'] as const

  it('falls back when unset or unknown', () => {
    expect(oneOf(undefined, allowed, 'free')).toBe('free')
    expect(oneOf('chess', allowed, 'free')).toBe('free')
  })

  it('does not care about case', () => {
    expect(oneOf('RENJU', allowed, 'free')).toBe('renju')
  })
})

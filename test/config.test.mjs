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
import { text, flag, count, oneOf } from '../src/lib/config.ts'

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

check('count: unset falls back', count(undefined, 4, { min: 2, max: 6 }), 4)
check('count: empty string falls back', count('', 4, { min: 2, max: 6 }), 4)
check('count: whitespace falls back', count('   ', 4, { min: 2, max: 6 }), 4)
check('count: a real zero is honoured', count('0', 260, { min: 0, max: 5000 }), 0)
check('count: a value is used', count('5', 4, { min: 2, max: 6 }), 5)
check('count: above the range clamps', count('99', 4, { min: 2, max: 6 }), 6)
check('count: below the range clamps', count('1', 4, { min: 2, max: 6 }), 2)
check('count: nonsense falls back', count('deep', 4, { min: 2, max: 6 }), 4)
check('count: a fraction truncates', count('4.9', 2, { min: 2, max: 6 }), 4)

check('text: unset falls back', text(undefined, 'https://example.com'), 'https://example.com')
check('text: empty falls back', text('  ', 'https://example.com'), 'https://example.com')
check('text: a value is trimmed', text('  hi  ', 'x'), 'hi')

check('flag: unset falls back', flag(undefined, true), true)
check('flag: empty falls back', flag('', true), true)
check('flag: false is honoured', flag('false', true), false)
check('flag: yes reads as true', flag('yes', false), true)
check('flag: 1 reads as true', flag('1', false), true)

check('oneOf: unset falls back', oneOf(undefined, ['free', 'renju'], 'free'), 'free')
check('oneOf: an unknown value falls back', oneOf('chess', ['free', 'renju'], 'free'), 'free')
check('oneOf: case does not matter', oneOf('RENJU', ['free', 'renju'], 'free'), 'renju')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

/**
 * A model can ignore a response constraint, answer in prose, or prepend a
 * status line. Reading a usable index out of whatever came back is what keeps
 * a formatting quirk from ending the turn.
 */

import { parseChoiceIndex } from '../src/lib/ai/providers.js'

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
const rejects = (name, raw, count) => {
  try {
    parseChoiceIndex(raw, count)
    fail += 1
    console.log(`FAIL  ${name}\n      expected it to throw`)
  } catch {
    pass += 1
    console.log(`PASS  ${name}`)
  }
}

check('constrained JSON object', parseChoiceIndex('{"choice": 2}', 8), 2)
check('bare JSON number', parseChoiceIndex('3', 8), 3)
check('prose naming a number', parseChoiceIndex('I choose move 5 because it blocks.', 8), 5)
check('status line before the JSON', parseChoiceIndex('On-device model ready\n{"choice": 1}', 8), 1)
check('index zero is a real answer', parseChoiceIndex('{"choice": 0}', 8), 0)
check('whitespace and code fences', parseChoiceIndex('```json\n{"choice": 4}\n```', 8), 4)
check('an out-of-range JSON value falls back to a usable number', parseChoiceIndex('{"choice": 99} or 6', 8), 6)

rejects('prose with no number', 'On-device something went wrong', 8)
rejects('only out-of-range numbers', '42', 8)
rejects('an empty reply', '', 8)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

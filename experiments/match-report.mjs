/**
 * Print a finished match as something a person can read.
 *
 *   node experiments/match-report.mjs <match-id>
 *
 * Thinking time is the only figure measured the same way for every player, so
 * it leads. Everything under a move's metrics is whatever that player could
 * account for, and carries the source that produced it.
 */

const MATCH = process.argv[2]
const BASE = process.env.GOMOKU_URL ?? 'http://localhost:5273'
if (!MATCH) {
  console.error('usage: node experiments/match-report.mjs <match-id>')
  process.exit(2)
}

const response = await fetch(`${BASE}/api/match/${MATCH}/review`)
if (!response.ok) {
  console.error(`could not read the review: ${response.status}`)
  process.exit(1)
}
const review = await response.json()

const ms = (value) =>
  value == null ? '—' : value < 1000 ? `${value}ms` : `${(value / 1000).toFixed(1)}s`

const label = (side) => side.player.label ?? side.player.kind

console.log(`\n${label(review.sides.black)}  vs  ${label(review.sides.white)}`)
console.log(`${review.ruleSet} · ${review.moves.length} moves · ${ms(review.durationMs)}`)
console.log(
  review.status === 'win'
    ? `${review.winner} wins with ${review.winningStones.join(' ')}`
    : review.status,
)

console.log('\n  #  side   point  thinking  reason')
console.log('  ' + '-'.repeat(74))
for (const move of review.moves) {
  const refused = move.rejected.length ? `  [refused ${move.rejected.map((r) => r.point).join(' ')}]` : ''
  console.log(
    `${String(move.n).padStart(3)}  ${move.seat.padEnd(6)} ${move.point.padEnd(6)} ` +
      `${ms(move.thinkingMs).padStart(8)}  ${(move.note ?? '').slice(0, 44)}${refused}`,
  )
}

console.log('\nper side')
const rows = [
  ['moves', (s) => s.moves],
  ['total thinking', (s) => ms(s.thinking.totalMs)],
  ['median', (s) => ms(s.thinking.medianMs)],
  ['slowest', (s) => ms(s.thinking.slowestMs)],
  ['fastest', (s) => ms(s.thinking.fastestMs)],
  ['refused', (s) => s.rejected],
]
const keys = new Set()
for (const side of [review.sides.black, review.sides.white]) {
  for (const key of Object.keys(side.metrics ?? {})) if (key !== 'sources') keys.add(key)
}
for (const key of keys) rows.push([key, (s) => s.metrics?.[key] ?? '—'])

console.log(`  ${''.padEnd(16)}${'black'.padStart(14)}${'white'.padStart(14)}`)
for (const [name, get] of rows) {
  console.log(
    `  ${name.padEnd(16)}${String(get(review.sides.black)).padStart(14)}${String(get(review.sides.white)).padStart(14)}`,
  )
}

const sources = new Set([
  ...(review.sides.black.metrics?.sources ?? []),
  ...(review.sides.white.metrics?.sources ?? []),
])
if (sources.size) console.log(`\n  metric sources: ${[...sources].join(', ')}`)
console.log(`\n  ${review.note}\n`)

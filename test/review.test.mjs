/**
 * The review record.
 *
 * What a player can account for differs by what it is, so the record keeps
 * whatever each one produced and says where the number came from. The one
 * figure that is comparable across all of them is thinking time, because the
 * server measures it rather than taking the player's word.
 */

import { startServer, reporter } from './helpers.mjs'

const { check, truthy, done } = reporter()

const { base: BASE, stop } = await startServer()

const json = async (path, options) => {
  const response = await fetch(`${BASE}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...options,
  })
  return { status: response.status, body: await response.json() }
}

const created = await json('/api/match', {
  method: 'POST',
  body: JSON.stringify({
    ruleSet: 'renju',
    black: { kind: 'agent', label: 'harness' },
    white: { kind: 'engine', label: 'Minimax' },
  }),
})
const id = created.body.id

const play = (seat, point, extra = {}) =>
  json(`/api/match/${id}/play`, { method: 'POST', body: JSON.stringify({ seat, point, ...extra }) })

// A pause the server can measure, so thinking time is not trivially zero.
await new Promise((r) => setTimeout(r, 60))
await play('black', 'H8', {
  note: 'centre',
  metrics: { source: 'reported', input_tokens: 120, output_tokens: 8, model: 'some-agent' },
})
await play('white', 'J9', {
  by: 'Minimax',
  metrics: { source: 'measured', model: 'minimax depth 4', work: '1,519 nodes' },
})

// An illegal attempt is kept, and does not cost the turn.
const occupied = await play('black', 'H8')
check('an occupied point is refused', occupied.body.error, 'illegal_move')
const garbage = await play('black', 'Z99')
check('an unparseable point is refused', garbage.body.error, 'bad_point')
await play('black', 'J8', { note: 'after two refusals' })

const review = (await json(`/api/match/${id}/review`)).body

check('the review covers every move played', review.moves.length, 3)
check('and keeps the rule set', review.ruleSet, 'renju')
truthy(
  'thinking time is measured for the first move',
  review.moves[0].thinkingMs >= 50,
  `got ${review.moves[0].thinkingMs}ms`,
)
check('a stated reason is kept', review.moves[0].note, 'centre')

const third = review.moves[2]
check('both refusals are attached to the move that followed', third.rejected.length, 2)
check(
  'with the reason for each',
  third.rejected.map((r) => r.reason),
  ['occupied', 'bad-point'],
)

check('a reported metric is labelled as reported', review.moves[0].metrics.source, 'reported')
check('a measured metric is labelled as measured', review.moves[1].metrics.source, 'measured')
check('reported token counts are kept', review.moves[0].metrics.input_tokens, 120)
check('a search engine’s own account is kept', review.moves[1].metrics.work, '1,519 nodes')

check('per-side move counts', [review.sides.black.moves, review.sides.white.moves], [2, 1])
check('refusals are counted per side', review.sides.black.rejected, 2)
truthy('a side total is summed', review.sides.black.thinking.totalMs > 0)
truthy('a median is reported', review.sides.black.thinking.medianMs !== null)
check('metric sources are carried into the side total', review.sides.black.metrics.sources, ['reported'])
check('and summed per key', review.sides.black.metrics.input_tokens, 120)

// A confidence is not a quantity of work: adding them would be meaningless.
await play('white', 'K10', { metrics: { source: 'measured', confidence: 0.8 } })
await play('black', 'L11', { metrics: { source: 'reported', confidence: 0.4, input_tokens: 30 } })
await play('white', 'M12', { metrics: { source: 'measured', confidence: 0.6 } })
const averaged = (await json(`/api/match/${id}/review`)).body
check('a confidence is averaged, not summed', averaged.sides.white.metrics['mean confidence'], 0.7)
check('and the raw key is not also totalled', averaged.sides.white.metrics.confidence, undefined)
check('token counts still add up', averaged.sides.black.metrics.input_tokens, 150)
check(
  'a side with no metrics of a kind does not invent one',
  review.sides.white.metrics.input_tokens,
  undefined,
)
check('but its source is still recorded', review.sides.white.metrics.sources, ['measured'])

check('positions include the empty board and one frame per move', review.positions.length, 4)
check(
  'the first frame is empty',
  review.positions[0].every((cell) => cell === 0),
  true,
)
check('the last frame has all three stones', review.positions[3].filter((cell) => cell !== 0).length, 3)

const missing = await json('/api/match/not-a-real-id/review')
check('a review of an unknown match is a 404', missing.status, 404)

await stop()
done()

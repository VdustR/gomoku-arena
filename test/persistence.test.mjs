/**
 * A match must survive the server restarting under it.
 *
 * Match state used to live only in memory, so a source edit — which reloads
 * the dev server on its own — ended every game in progress. Two agents
 * mid-match cannot recover from that and have no reason to expect it.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer, stop, reporter } from './helpers.mjs'

const { check, truthy, done } = reporter()
const STATE_DIR = mkdtempSync(join(tmpdir(), 'gomoku-state-'))

const json = async (base, path, options) => {
  const response = await fetch(`${base}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...options,
  })
  return { status: response.status, body: await response.json() }
}

// First run: open a match and play into it.
const first = await startServer({ GOMOKU_STATE_DIR: STATE_DIR })
const created = await json(first.base, '/api/match', {
  method: 'POST',
  body: JSON.stringify({
    ruleSet: 'renju',
    black: { kind: 'agent', label: 'black' },
    white: { kind: 'agent', label: 'white' },
  }),
})
const id = created.body.id

for (const [seat, point, note] of [
  ['black', 'H8', 'centre'],
  ['white', 'J9', null],
  ['black', 'J8', 'building'],
]) {
  await json(first.base, `/api/match/${id}/play`, {
    method: 'POST',
    body: JSON.stringify({ seat, point, note }),
  })
}
await json(first.base, `/api/match/${id}/play`, {
  method: 'POST',
  body: JSON.stringify({ seat: 'white', point: 'H8' }),
})
await stop(first.child)

// Second run: a different process, the same state directory.
const second = await startServer({ GOMOKU_STATE_DIR: STATE_DIR })
const after = await json(second.base, `/api/match/${id}`)

check('the match is still there after a restart', after.status, 200)
check('with its stones', after.body.board.black, ['H8', 'J8'])
check('and the opponent’s', after.body.board.white, ['J9'])
check('the side to move is preserved', after.body.turn, 'white')
check('the rule set is preserved', after.body.ruleSet, 'renju')
check('the move count is preserved', after.body.moves, 3)

const review = (await json(second.base, `/api/match/${id}/review`)).body
check('stated reasons survive', review.moves[0].note, 'centre')
truthy('thinking time survives', typeof review.moves[0].thinkingMs === 'number')

// The restored match is still playable, not just readable.
const resumed = await json(second.base, `/api/match/${id}/play`, {
  method: 'POST',
  body: JSON.stringify({ seat: 'white', point: 'K10', note: 'after the restart' }),
})
check('play resumes on the restored match', resumed.status, 200)
// Stone lists are in board order, not move order.
check('and the stone lands', [...resumed.body.board.white].sort(), ['J9', 'K10'])

/*
 * A refusal is held against the side that made it until that side plays, so
 * it only reaches the record with the move that follows. It changes no stone,
 * which means nothing else would save it — the restart above is what proves
 * it was written.
 */
const afterResume = (await json(second.base, `/api/match/${id}/review`)).body
const whiteMove = afterResume.moves.find((m) => m.point === 'K10')
check('the refusal from before the restart is attached', whiteMove.rejected.length, 1)
check('with its reason', whiteMove.rejected[0].reason, 'occupied')
check('and the point that was refused', whiteMove.rejected[0].point, 'H8')

const listed = (await json(second.base, '/api/matches')).body
truthy(
  'the restored match is listed',
  listed.matches.some((m) => m.id === id),
)

/*
 * The stored file holds the move list and nothing derived from it. A board,
 * a winner or a side-to-move written alongside would be a second copy of the
 * same fact, free to disagree with the moves after any change.
 */
const files = readdirSync(STATE_DIR).filter((name) => name.endsWith('.json'))
check('one file per match', files.length, 1)
const stored = JSON.parse(readFileSync(join(STATE_DIR, files[0]), 'utf8'))
check('the record says which shape it is', stored.formatVersion, 1)
check('the move list is stored', stored.history.length, 4)
check('the rules are stored', stored.ruleSet, 'renju')
truthy('the seats are stored', Boolean(stored.seats))
check('the board is not stored', stored.board, undefined)
check('the side to move is not stored', stored.turn, undefined)
check('the winner is not stored', stored.winner, undefined)
check('the status is not stored', stored.status, undefined)

// A file on its own is enough: a third server sees the same match.
const third = await startServer({ GOMOKU_STATE_DIR: STATE_DIR })
const replayed = await json(third.base, `/api/match/${id}`)
check('a fresh server replays the same position', replayed.body.board.white.length, 2)
check('and the same side to move', replayed.body.turn, 'black')
await stop(third.child)

/*
 * A take-back is not in the move list it leaves behind, so nothing that
 * replays would know it happened. It has to be written, or a player refused
 * after a restart is told only that it played out of turn — the same message
 * it would get for genuinely misbehaving.
 */
const rewound = await json(second.base, `/api/match/${id}/undo`, {
  method: 'POST',
  body: JSON.stringify({ count: 1 }),
})
check('take back answers', rewound.status, 200)
check('and the board says it was rewound', rewound.body.rewound.dropped, 1)
await stop(second.child)

const fourth = await startServer({ GOMOKU_STATE_DIR: STATE_DIR })
const afterRestart = await json(fourth.base, `/api/match/${id}`)
check('the take-back survives the restart', afterRestart.body.rewound.dropped, 1)
check('naming the stone it removed', afterRestart.body.rewound.points, ['K10'])

// Black is not on move here; the refusal must explain why rather than accuse.
const refused = await json(fourth.base, `/api/match/${id}/play`, {
  method: 'POST',
  body: JSON.stringify({ seat: 'black', point: 'C3' }),
})
check('a stale move is refused', refused.body.error, 'not_your_turn')
check('and the refusal still carries the take-back', refused.body.rewound.dropped, 1)
truthy('with the version it was judged against', typeof refused.body.version === 'number')
await stop(fourth.child)

/*
 * A file this server cannot read is one match it will not show, not a broken
 * store — and it is left where it is. Four pre-refactor records sat in a
 * working directory this week and loaded without complaint; refusing them is
 * the point, but deleting somebody's game because it could not be parsed is
 * worse than saying so and leaving it alone.
 */
const garbage = join(STATE_DIR, 'not-json.json')
const preRefactor = join(STATE_DIR, 'pre-refactor.json')
writeFileSync(garbage, '{ this is not json')
writeFileSync(
  preRefactor,
  JSON.stringify({
    id: 'stale-record',
    ruleSet: 'free',
    seats: {
      1: { kind: 'human', label: null, assist: 'free' },
      2: { kind: 'human', label: null, assist: 'free' },
    },
    history: [],
    rejected: { 1: [], 2: [] },
    // The fields that make it stale: all four are replayed, never stored.
    board: Array.from({ length: 225 }, () => 0),
    turn: 1,
    status: 'playing',
    winner: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 0,
  }),
)

const fifth = await startServer({ GOMOKU_STATE_DIR: STATE_DIR })
const survivors = (await json(fifth.base, '/api/matches')).body.matches
truthy(
  'a readable record still loads beside unreadable ones',
  survivors.some((m) => m.id === id),
)
check(
  'the stale record is not loaded',
  survivors.some((m) => m.id === 'stale-record'),
  false,
)
truthy('the unreadable file is left where it is', existsSync(garbage))
truthy('and so is the stale one', existsSync(preRefactor))
await stop(fifth.child)

rmSync(STATE_DIR, { recursive: true, force: true })
done()

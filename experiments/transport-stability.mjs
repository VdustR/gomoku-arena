/**
 * Is MCP a stable way to move the bits?
 *
 * The decision is identical on both routes — the same Jev call, the same
 * candidates, the same prompt — so the only thing that differs is how the
 * position is read and how the move reaches the board:
 *
 *   mcp   get_state / play, over Streamable HTTP
 *   http  GET /api/match/:id and POST /api/match/:id/play
 *
 * Holding the model and the control loop fixed is the point. Comparing MCP
 * against "an agent harness with an SDK" would measure the harness, not the
 * transport.
 *
 * Read and write are timed separately from the decision, because a game's
 * length is noise here: two runs diverge after the first differing move, and
 * counting turns or tokens then measures the game, not the plumbing. What is
 * comparable is the cost and failure rate of one read and one write.
 *
 *   node experiments/transport-stability.mjs [games-per-route]
 *
 * Needs TYPESAFE_API_KEY. Runs against a server it starts itself.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startServer, stop } from '../test/helpers.mjs'

const GAMES = Number(process.argv[2] ?? 5)
const MAX_PLIES = 120
const KEY = process.env.TYPESAFE_API_KEY
if (!KEY) {
  console.error('TYPESAFE_API_KEY is not set. Run through envctl.')
  process.exit(2)
}

const { child, base, port } = await startServer()
const MCP_URL = `http://127.0.0.1:${port}/mcp`

const api = async (path, options = {}) => {
  const response = await fetch(`${base}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...options,
  })
  return { status: response.status, body: await response.json() }
}

/** One Jev decision over the candidate points. Identical on both routes. */
async function askJev(state, candidates) {
  const criteria = {}
  for (const move of candidates) criteria[move.point] = move.rationale ?? 'a legal point'
  const started = performance.now()
  const relayed = await api('/api/jev', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-provider-key': KEY },
    body: JSON.stringify({
      baseUrl: 'https://api.typesafe.ai/v1',
      request: {
        state,
        model: 'jev-latest',
        questions: {
          move: {
            type: 'choice',
            instructions:
              'Which point should you play next? Weigh your own winning threats against the opponent’s.',
            criteria,
          },
        },
      },
    }),
  })
  const decidedInMs = Math.round(performance.now() - started)
  if (!relayed.body.ok) throw new Error(relayed.body.body?.error ?? 'jev call failed')
  const answer = relayed.body.body.answers?.move
  return {
    point: answer?.choice ?? candidates[0].point,
    confidence: answer?.confidence ?? null,
    usage: relayed.body.body.usage ?? {},
    decidedInMs,
  }
}

/** Reading the position and playing a move, once per transport. */
const ROUTES = {
  http: {
    label: 'plain HTTP API',
    async open(seats) {
      const created = await api('/api/match', { method: 'POST', body: JSON.stringify(seats) })
      if (created.status !== 201) throw new Error(`could not open a match: ${created.status}`)
      return created.body.id
    },
    async read(id) {
      const got = await api(`/api/match/${id}?seat=black`)
      if (got.status !== 200) throw new Error(`read failed: ${got.status}`)
      return got.body
    },
    async play(id, point, extra) {
      const result = await api(`/api/match/${id}/play`, {
        method: 'POST',
        body: JSON.stringify({ seat: 'black', point, ...extra }),
      })
      if (result.status !== 200) {
        const error = new Error(result.body.message ?? `play failed: ${result.status}`)
        error.code = result.body.error
        throw error
      }
      return result.body
    },
    async close() {},
  },

  mcp: {
    label: 'MCP tools',
    client: null,
    async connect() {
      this.client = new Client({ name: 'transport-stability', version: '1.0.0' })
      await this.client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)))
    },
    async call(tool, args) {
      const result = await this.client.callTool({ name: tool, arguments: args })
      const payload = JSON.parse(result.content[0].text)
      if (result.isError) {
        const error = new Error(payload.message ?? `${tool} failed`)
        error.code = payload.error
        throw error
      }
      return payload
    },
    async open(seats) {
      if (!this.client) await this.connect()
      const opened = await this.call('new_match', {
        rule_set: seats.ruleSet,
        black: seats.black,
        white: seats.white,
      })
      return opened.id
    },
    async read(id) {
      return this.call('get_state', { match_id: id, seat: 'black', candidates: true })
    },
    async play(id, point, extra) {
      return this.call('play', { match_id: id, seat: 'black', point, note: extra.note ?? undefined })
    },
    async close() {
      await this.client?.close()
      this.client = null
    },
  },
}

/** Everything that could go wrong on a turn, counted rather than thrown away. */
const blankTally = () => ({
  games: 0,
  completed: 0,
  turns: 0,
  refused: 0,
  transportErrors: 0,
  decisionErrors: 0,
  readLatencies: [],
  writeLatencies: [],
  decisionLatencies: [],
  inputTokens: 0,
  results: [],
  errorSamples: [],
})

const percentile = (values, p) => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

async function playGame(route, tally) {
  const id = await route.open({
    ruleSet: 'free',
    black: { kind: 'agent', label: `jev-via-${route === ROUTES.mcp ? 'mcp' : 'http'}`, assist: 'shortlist' },
    // The opponent needs a shortlist too, or it has nothing to pick from.
    white: { kind: 'engine', label: 'opponent', assist: 'shortlist' },
  })

  for (let ply = 0; ply < MAX_PLIES; ply += 1) {
    let state
    const readStarted = performance.now()
    try {
      state = await route.read(id)
      tally.readLatencies.push(Math.round(performance.now() - readStarted))
    } catch (error) {
      tally.transportErrors += 1
      tally.errorSamples.push(`read: ${error.message}`)
      return 'transport-error'
    }
    if (state.status !== 'playing') return state.status

    if (state.turn === 'white') {
      /*
       * The opponent is driven here so the game advances. Its candidates must
       * be read for white: asking for black's shortlist while white is to move
       * gives the wrong side's points, and the two routes then play different
       * games for a reason that has nothing to do with transport.
       */
      const forWhite = await api(`/api/match/${id}?seat=white`)
      const point = forWhite.body.candidates?.[0]?.point
      if (!point) return 'no-move'
      try {
        await api(`/api/match/${id}/play`, {
          method: 'POST',
          body: JSON.stringify({ seat: 'white', point, by: 'opponent' }),
        })
      } catch {
        tally.transportErrors += 1
        return 'transport-error'
      }
      continue
    }

    const candidates = state.candidates ?? []
    if (candidates.length === 0) return 'no-move'

    let decision
    try {
      decision = await askJev(
        { board: state.board.ascii, you_play: 'black', rule_set: state.ruleSummary },
        candidates,
      )
      tally.decisionLatencies.push(decision.decidedInMs)
      tally.inputTokens += decision.usage.input_tokens ?? 0
    } catch (error) {
      tally.decisionErrors += 1
      tally.errorSamples.push(`decide: ${error.message}`)
      return 'decision-error'
    }

    const writeStarted = performance.now()
    try {
      await route.play(id, decision.point, { note: `confidence ${decision.confidence ?? '?'}` })
      tally.turns += 1
      tally.writeLatencies.push(Math.round(performance.now() - writeStarted))
    } catch (error) {
      if (error.code === 'illegal_move' || error.code === 'bad_point') {
        tally.refused += 1
        continue
      }
      tally.transportErrors += 1
      tally.errorSamples.push(`play: ${error.message}`)
      return 'transport-error'
    }
  }
  return 'move-limit'
}

const report = {}
for (const [name, route] of Object.entries(ROUTES)) {
  const tally = blankTally()
  for (let game = 0; game < GAMES; game += 1) {
    tally.games += 1
    let outcome
    try {
      outcome = await playGame(route, tally)
    } catch (error) {
      outcome = 'crashed'
      tally.transportErrors += 1
      tally.errorSamples.push(`game: ${error.message}`)
    }
    tally.results.push(outcome)
    if (outcome === 'win' || outcome === 'draw') tally.completed += 1
    process.stdout.write(`${name} game ${game + 1}/${GAMES}: ${outcome}\n`)
  }
  await route.close()
  report[name] = {
    label: route.label,
    ...tally,
    read: {
      medianMs: percentile(tally.readLatencies, 50),
      p95Ms: percentile(tally.readLatencies, 95),
      maxMs: tally.readLatencies.length ? Math.max(...tally.readLatencies) : null,
    },
    write: {
      medianMs: percentile(tally.writeLatencies, 50),
      p95Ms: percentile(tally.writeLatencies, 95),
      maxMs: tally.writeLatencies.length ? Math.max(...tally.writeLatencies) : null,
    },
    decision: {
      medianMs: percentile(tally.decisionLatencies, 50),
    },
    readLatencies: undefined,
    writeLatencies: undefined,
    decisionLatencies: undefined,
  }
}

await stop(child)

const row = (name, get) =>
  `${name.padEnd(24)} ${String(get(report.mcp)).padStart(14)} ${String(get(report.http)).padStart(14)}`

console.log(`\n${''.padEnd(24)} ${'MCP tools'.padStart(14)} ${'plain HTTP'.padStart(14)}`)
console.log('-'.repeat(56))
console.log(row('games', (r) => r.games))
console.log(row('turns played', (r) => r.turns))
console.log('')
console.log('reliability')
console.log(row('  refused moves', (r) => r.refused))
console.log(row('  transport errors', (r) => r.transportErrors))
console.log(row('  decision errors', (r) => r.decisionErrors))
console.log(
  row('  failure rate', (r) => {
    const attempts = r.turns + r.transportErrors + r.refused
    return attempts ? `${((100 * (r.transportErrors + r.refused)) / attempts).toFixed(2)}%` : '-'
  }),
)
console.log('')
console.log('read the position')
console.log(row('  median (ms)', (r) => r.read.medianMs ?? '-'))
console.log(row('  p95 (ms)', (r) => r.read.p95Ms ?? '-'))
console.log(row('  max (ms)', (r) => r.read.maxMs ?? '-'))
console.log('')
console.log('submit the move')
console.log(row('  median (ms)', (r) => r.write.medianMs ?? '-'))
console.log(row('  p95 (ms)', (r) => r.write.p95Ms ?? '-'))
console.log(row('  max (ms)', (r) => r.write.maxMs ?? '-'))
console.log('')
console.log(row('decision median (ms)', (r) => r.decision.medianMs ?? '-'))
console.log()
for (const [name, data] of Object.entries(report)) {
  if (data.errorSamples.length) console.log(`${name} errors:`, data.errorSamples.slice(0, 5))
}
console.log('\noutcomes:', JSON.stringify({ mcp: report.mcp.results, http: report.http.results }))

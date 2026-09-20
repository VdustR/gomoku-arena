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
 *   node experiments/transport-stability.ts [games-per-route]
 *
 * Needs TYPESAFE_API_KEY. Runs against a server it starts itself.
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { connectMcp, startServer, stop } from '../test/helpers.ts'
import type { Candidate, NewMatch, PublicMatch } from '../server/match.ts'

const GAMES = Number(process.argv[2] ?? 5)
const MAX_PLIES = 120
const KEY = process.env['TYPESAFE_API_KEY'] ?? ''
if (!KEY) {
  console.error('TYPESAFE_API_KEY is not set. Run through envctl.')
  process.exit(2)
}

const { child, base } = await startServer()

const api = async <T>(path: string, options: RequestInit = {}): Promise<{ status: number; body: T }> => {
  const response = await fetch(`${base}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...options,
  })
  return { status: response.status, body: (await response.json()) as T }
}

/**
 * A refusal as the server writes one, on either route. It is not the shape
 * the success type describes, so it is named separately and read alongside it.
 */
interface ApiRefusal {
  error?: string
  message?: string
}

/**
 * An Error carrying the server's refusal code, so a turn refused by the rules
 * can be told apart from the transport falling over.
 */
class RouteError extends Error {
  code: string | undefined

  constructor(message: string, code: string | undefined) {
    super(message)
    this.code = code
  }
}

/** What the relay hands back for a Jev call: its own envelope, then the body. */
interface JevEnvelope {
  ok: boolean
  status: number
  body?: {
    error?: string
    answers?: { move?: { choice?: string; confidence?: number | null } }
    usage?: { input_tokens?: number }
  }
}

interface Decision {
  point: string
  confidence: number | null
  usage: { input_tokens?: number }
  decidedInMs: number
}

/** One Jev decision over the candidate points. Identical on both routes. */
async function askJev(
  state: { board: string; you_play: string; rule_set: string },
  candidates: Candidate[],
): Promise<Decision> {
  const criteria: Record<string, string> = {}
  for (const move of candidates) criteria[move.point] = move.rationale ?? 'a legal point'
  // The shortlist is never empty by the time this is called; saying so here is
  // what lets the fallback point be read without an assertion.
  const fallback = candidates[0]
  if (!fallback) throw new Error('no candidates to choose from')
  const started = performance.now()
  const relayed = await api<JevEnvelope>('/api/jev', {
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
  const answer = relayed.body.body?.answers?.move
  return {
    point: answer?.choice ?? fallback.point,
    confidence: answer?.confidence ?? null,
    usage: relayed.body.body?.usage ?? {},
    decidedInMs,
  }
}

/** Reading the position and playing a move, once per transport. */
interface Route {
  label: string
  open(seats: NewMatch): Promise<string>
  read(id: string): Promise<PublicMatch>
  play(id: string, point: string, extra: { note?: string | undefined }): Promise<unknown>
  close(): Promise<void>
}

/** The MCP route also holds the connection it reads and writes over. */
interface McpRoute extends Route {
  client: Client | null
  connect(): Promise<void>
  call<T>(tool: string, args: Record<string, unknown>): Promise<T>
}

const httpRoute: Route = {
  label: 'plain HTTP API',
  async open(seats) {
    const created = await api<PublicMatch>('/api/match', { method: 'POST', body: JSON.stringify(seats) })
    if (created.status !== 201) throw new Error(`could not open a match: ${created.status}`)
    return created.body.id
  },
  async read(id) {
    const got = await api<PublicMatch>(`/api/match/${id}?seat=black`)
    if (got.status !== 200) throw new Error(`read failed: ${got.status}`)
    return got.body
  },
  async play(id, point, extra) {
    const result = await api<PublicMatch & ApiRefusal>(`/api/match/${id}/play`, {
      method: 'POST',
      body: JSON.stringify({ seat: 'black', point, ...extra }),
    })
    if (result.status !== 200) {
      throw new RouteError(result.body.message ?? `play failed: ${result.status}`, result.body.error)
    }
    return result.body
  },
  async close() {},
}

const mcpRoute: McpRoute = {
  label: 'MCP tools',
  client: null,
  async connect() {
    this.client = await connectMcp(base, 'transport-stability')
  },
  async call<T>(tool: string, args: Record<string, unknown>): Promise<T> {
    const client = this.client
    if (!client) throw new Error(`${tool} was called before the client connected`)
    const result = await client.callTool({ name: tool, arguments: args })
    /*
     * The SDK types `content` as a union of block kinds, and only the text
     * block carries `text`. Narrowing rather than asserting keeps a non-text
     * reply from being read as an answer.
     */
    const content = Array.isArray(result.content) ? result.content : []
    const first = content[0]
    if (!first || first.type !== 'text') throw new Error(`${tool} did not answer with text`)
    const payload = JSON.parse(first.text) as T & ApiRefusal
    if (result.isError) {
      throw new RouteError(payload.message ?? `${tool} failed`, payload.error)
    }
    return payload
  },
  async open(seats) {
    if (!this.client) await this.connect()
    const opened = await this.call<PublicMatch>('new_match', {
      rule_set: seats.ruleSet,
      black: seats.black,
      white: seats.white,
    })
    return opened.id
  },
  async read(id) {
    return this.call<PublicMatch>('get_state', { match_id: id, seat: 'black', candidates: true })
  },
  async play(id, point, extra) {
    return this.call('play', { match_id: id, seat: 'black', point, note: extra.note ?? undefined })
  },
  async close() {
    await this.client?.close()
    this.client = null
  },
}

const ROUTE_NAMES = ['http', 'mcp'] as const
type RouteName = (typeof ROUTE_NAMES)[number]

const ROUTES: Record<RouteName, Route> = {
  http: httpRoute,
  mcp: mcpRoute,
}

/** Everything that could go wrong on a turn, counted rather than thrown away. */
interface Tally {
  games: number
  completed: number
  turns: number
  refused: number
  transportErrors: number
  decisionErrors: number
  readLatencies: number[]
  writeLatencies: number[]
  decisionLatencies: number[]
  inputTokens: number
  results: string[]
  errorSamples: string[]
}

const blankTally = (): Tally => ({
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

const percentile = (values: number[], p: number): number | null => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? null
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

async function playGame(route: Route, tally: Tally): Promise<string> {
  const id = await route.open({
    ruleSet: 'free',
    black: { kind: 'agent', label: `jev-via-${route === ROUTES.mcp ? 'mcp' : 'http'}`, assist: 'shortlist' },
    // The opponent needs a shortlist too, or it has nothing to pick from.
    white: { kind: 'engine', label: 'opponent', assist: 'shortlist' },
  })

  for (let ply = 0; ply < MAX_PLIES; ply += 1) {
    let state: PublicMatch
    const readStarted = performance.now()
    try {
      state = await route.read(id)
      tally.readLatencies.push(Math.round(performance.now() - readStarted))
    } catch (error) {
      tally.transportErrors += 1
      tally.errorSamples.push(`read: ${message(error)}`)
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
      const forWhite = await api<PublicMatch>(`/api/match/${id}?seat=white`)
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

    let decision: Decision
    try {
      decision = await askJev(
        { board: state.board.ascii, you_play: 'black', rule_set: state.ruleSummary },
        candidates,
      )
      tally.decisionLatencies.push(decision.decidedInMs)
      tally.inputTokens += decision.usage.input_tokens ?? 0
    } catch (error) {
      tally.decisionErrors += 1
      tally.errorSamples.push(`decide: ${message(error)}`)
      return 'decision-error'
    }

    const writeStarted = performance.now()
    try {
      await route.play(id, decision.point, { note: `confidence ${decision.confidence ?? '?'}` })
      tally.turns += 1
      tally.writeLatencies.push(Math.round(performance.now() - writeStarted))
    } catch (error) {
      if (error instanceof RouteError && (error.code === 'illegal_move' || error.code === 'bad_point')) {
        tally.refused += 1
        continue
      }
      tally.transportErrors += 1
      tally.errorSamples.push(`play: ${message(error)}`)
      return 'transport-error'
    }
  }
  return 'move-limit'
}

interface Latencies {
  medianMs: number | null
  p95Ms: number | null
  maxMs: number | null
}

/**
 * The raw latency arrays are dropped once the summary is taken from them: the
 * report is the thing anyone reads, and thousands of samples in it are noise.
 */
interface RouteReport extends Omit<Tally, 'readLatencies' | 'writeLatencies' | 'decisionLatencies'> {
  label: string
  read: Latencies
  write: Latencies
  decision: { medianMs: number | null }
  readLatencies: undefined
  writeLatencies: undefined
  decisionLatencies: undefined
}

const report = {} as Record<RouteName, RouteReport>
for (const name of ROUTE_NAMES) {
  const route = ROUTES[name]
  const tally = blankTally()
  for (let game = 0; game < GAMES; game += 1) {
    tally.games += 1
    let outcome
    try {
      outcome = await playGame(route, tally)
    } catch (error) {
      outcome = 'crashed'
      tally.transportErrors += 1
      tally.errorSamples.push(`game: ${message(error)}`)
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

const row = (name: string, get: (r: RouteReport) => unknown): string =>
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
for (const name of ROUTE_NAMES) {
  const data = report[name]
  if (data.errorSamples.length) console.log(`${name} errors:`, data.errorSamples.slice(0, 5))
}
console.log('\noutcomes:', JSON.stringify({ mcp: report.mcp.results, http: report.http.results }))

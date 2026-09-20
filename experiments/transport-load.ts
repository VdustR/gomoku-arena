/**
 * How reliable is each transport under repetition and concurrency?
 *
 * The end-to-end run in transport-stability.ts is realistic but small: a
 * hundred turns of zero failures cannot distinguish a 0% failure rate from a
 * 3% one. This drops the model entirely and exercises the two transports
 * directly, which buys thousands of operations in the time a few games took.
 *
 *   node experiments/transport-load.ts [operations-per-route] [concurrency]
 *
 * Needs no credentials.
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { connectMcp, startServer, stop } from '../test/helpers.ts'
import type { PublicMatch } from '../server/match.ts'

const OPERATIONS = Number(process.argv[2] ?? 2000)
const CONCURRENCY = Number(process.argv[3] ?? 8)

const { child, base } = await startServer()

const api = async <T>(path: string, options: RequestInit = {}): Promise<{ status: number; body: T }> => {
  const response = await fetch(`${base}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...options,
  })
  return { status: response.status, body: (await response.json()) as T }
}

const opened = await api<PublicMatch>('/api/match', {
  method: 'POST',
  body: JSON.stringify({
    ruleSet: 'free',
    black: { kind: 'agent', assist: 'shortlist' },
    white: { kind: 'agent', assist: 'shortlist' },
  }),
})
const MATCH = opened.body.id

/**
 * One read of the position on each transport. Reads are what an agent does
 * most, and unlike a write they can repeat without changing the board, so the
 * two routes stay comparable across thousands of operations.
 *
 * `Connection` is whatever that route holds open between reads — an MCP
 * client, or nothing at all for plain HTTP — so the measuring loop can drive
 * either without knowing which it has.
 */
interface Route<Connection> {
  label: string
  open(): Promise<Connection>
  read(connection: Connection): Promise<void>
  close(connection: Connection): Promise<void>
}

const ROUTES: Record<string, Route<unknown>> = {
  mcp: {
    label: 'MCP tools',
    async open() {
      return connectMcp(base, 'load')
    },
    async read(client: Client) {
      const result = await client.callTool({
        name: 'get_state',
        arguments: { match_id: MATCH, seat: 'black' },
      })
      if (result.isError) throw new Error('tool reported an error')
      /*
       * The SDK types `content` as a union of block kinds, and only the text
       * block carries `text`. Narrowing rather than asserting keeps a non-text
       * reply from being read as a successful answer.
       */
      const content = Array.isArray(result.content) ? result.content : []
      const first = content[0]
      if (!first || first.type !== 'text') throw new Error('tool did not answer with text')
      const payload = JSON.parse(first.text) as PublicMatch
      if (payload.id !== MATCH) throw new Error('wrong match came back')
    },
    async close(client: Client) {
      await client.close()
    },
  },
  http: {
    label: 'plain HTTP',
    async open() {
      return null
    },
    async read() {
      const response = await fetch(`${base}/api/match/${MATCH}?seat=black`)
      if (!response.ok) throw new Error(`status ${response.status}`)
      const payload = (await response.json()) as PublicMatch
      if (payload.id !== MATCH) throw new Error('wrong match came back')
    },
    async close() {},
  },
}

const percentile = (values: number[], p: number): number | null => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? null
}

async function measure(route: Route<unknown>, { concurrency }: { concurrency: number }) {
  const latencies: number[] = []
  const errors: string[] = []
  let done = 0
  const startedAll = performance.now()

  // One client per worker: an agent holds a connection, it does not open one
  // per call, and pooling behaviour is part of what is being measured.
  const workers = Array.from({ length: concurrency }, async () => {
    const client = await route.open()
    try {
      for (;;) {
        if (done >= OPERATIONS) return
        done += 1
        const started = performance.now()
        try {
          await route.read(client)
          latencies.push(performance.now() - started)
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error))
        }
      }
    } finally {
      await route.close(client)
    }
  })

  await Promise.all(workers)
  const wallMs = performance.now() - startedAll

  return {
    label: route.label,
    operations: OPERATIONS,
    concurrency,
    failures: errors.length,
    failureRate: errors.length / OPERATIONS,
    throughputPerSec: Math.round((OPERATIONS / wallMs) * 1000),
    medianMs: percentile(latencies, 50)?.toFixed(2),
    p95Ms: percentile(latencies, 95)?.toFixed(2),
    p99Ms: percentile(latencies, 99)?.toFixed(2),
    maxMs: latencies.length ? Math.max(...latencies).toFixed(2) : null,
    errorSamples: [...new Set(errors)].slice(0, 3),
  }
}

type Measurement = Awaited<ReturnType<typeof measure>>

const report: Record<string, Measurement> = {}
for (const level of [1, CONCURRENCY]) {
  for (const [name, route] of Object.entries(ROUTES)) {
    process.stdout.write(`${name} at concurrency ${level}... `)
    report[`${name}@${level}`] = await measure(route, { concurrency: level })
    process.stdout.write('done\n')
  }
}

await stop(child)

console.log(`\n${OPERATIONS} reads per route\n`)
const header = ['', 'MCP c=1', 'HTTP c=1', `MCP c=${CONCURRENCY}`, `HTTP c=${CONCURRENCY}`]
const keys = ['mcp@1', 'http@1', `mcp@${CONCURRENCY}`, `http@${CONCURRENCY}`]
const line = (name: string, get: (r: Measurement) => unknown): string => {
  const cells = keys.map((key) => {
    const data = report[key]
    return String(data ? get(data) : '-').padStart(12)
  })
  return `${name.padEnd(18)} ${cells.join('')}`
}

console.log(
  `${(header[0] ?? '').padEnd(18)} ${header
    .slice(1)
    .map((h) => h.padStart(12))
    .join('')}`,
)
console.log('-'.repeat(66))
console.log(line('failures', (r) => r.failures))
console.log(line('failure rate', (r) => `${(r.failureRate * 100).toFixed(3)}%`))
console.log(line('median (ms)', (r) => r.medianMs))
console.log(line('p95 (ms)', (r) => r.p95Ms))
console.log(line('p99 (ms)', (r) => r.p99Ms))
console.log(line('max (ms)', (r) => r.maxMs))
console.log(line('reads/sec', (r) => r.throughputPerSec))

for (const [key, data] of Object.entries(report)) {
  if (data.errorSamples.length) console.log(`\n${key} errors:`, data.errorSamples)
}

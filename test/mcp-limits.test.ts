/** Normal MCP requests and bounded refusals through the installed SDK. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectMcp, startServer, stop, toolPayload } from './helpers.ts'
import type { TestServer } from './helpers.ts'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'

let server: TestServer
let alice: Client
let BASE: string

interface Payload {
  id?: string
  yourTurn?: boolean
  board?: { black?: string[] }
}

const call = async (client: Client, name: string, args: Record<string, unknown>) => {
  const result = await client.callTool({ name, arguments: args })
  return { isError: Boolean(result.isError), payload: toolPayload<Payload>(result) }
}

beforeAll(async () => {
  server = await startServer()
  BASE = server.base
  alice = await connectMcp(BASE, 'bounded-input')
})

afterAll(async () => {
  await alice?.close()
  if (server) await stop(server.child)
})

describe('bounded MCP input', () => {
  it('refuses excess metric elements before a move lands, then accepts an ordinary move', async () => {
    const id = (await call(alice, 'new_match', { rule_set: 'free' })).payload.id ?? ''
    const metrics = Object.fromEntries(Array.from({ length: 1024 }, (_, index) => [`metric_${index}`, 1]))
    const refused = await alice.callTool({
      name: 'play',
      arguments: { match_id: id, seat: 'black', point: 'H8', metrics },
    })
    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused.content)).toContain('maximum of 1024 elements')

    const seen = await call(alice, 'get_state', { match_id: id, seat: 'black' })
    expect(seen.payload.board?.black).toEqual([])
    expect(seen.payload.yourTurn).toBe(true)
    const played = await call(alice, 'play', {
      match_id: id,
      seat: 'black',
      point: 'H8',
      note: 'An ordinary move after a refused request.',
      metrics: { input_tokens: 42, provider: { name: 'test' } },
    })
    expect(played.isError).toBe(false)
    expect(played.payload.board?.black).toEqual(['H8'])
  })

  it('refuses a request larger than 64 KiB at the HTTP transport', async () => {
    const response = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', padding: 'x'.repeat(64 * 1024) }),
    })
    expect(response.status).toBe(413)
    expect(await response.text()).toContain('65536')
    expect((await alice.listTools()).tools).toHaveLength(9)
  })
})

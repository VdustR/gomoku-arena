/**
 * A one-shot MCP client, so a seat can be driven from a shell.
 *
 *   node scripts/mcp-cli.ts <tool> '<json args>'
 *
 * It is the same Streamable HTTP client a harness uses, which makes it a
 * convenient way to check the server by hand.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const [tool, ...rest] = process.argv.slice(2)
if (!tool) {
  console.error("usage: node scripts/mcp-cli.ts <tool> '<json args>'")
  process.exit(2)
}
/*
 * The endpoint, in the order of how much the caller meant it: an explicit
 * `GOMOKU_MCP_URL`, then whatever portless is serving this under, then the
 * default port. `PORTLESS_URL` carries its own scheme, so this works the
 * same whether the proxy is running HTTPS or `--no-tls`.
 */
const portless = process.env['PORTLESS_URL']
const url = process.env['GOMOKU_MCP_URL'] ?? (portless ? `${portless}/mcp` : 'http://localhost:5273/mcp')
const client = new Client({ name: process.env['MCP_CLIENT_NAME'] ?? 'mcp-cli', version: '1.0.0' })
/*
 * The SDK's own transport type is not assignable to the `Transport` its
 * `connect` takes once `exactOptionalPropertyTypes` is on: the interface
 * declares optional members that the class types as `T | undefined`, which
 * that flag treats as different things. The mismatch is upstream and entirely
 * in the type shape — the transport is the one the SDK tells callers to use —
 * so it is narrowed here at the one call rather than by relaxing the flag for
 * the whole project.
 */
await client.connect(new StreamableHTTPClientTransport(new URL(url)) as never)
const toolArguments: Record<string, unknown> = JSON.parse(rest.join(' ') || '{}')
/*
 * The SDK's request timeout is a different clock from the tool's own wait.
 *
 * `callTool` defaults to 60s (`DEFAULT_REQUEST_TIMEOUT_MSEC`) no matter what
 * `wait_ms` or `timeout_ms` the call carries, so `play` with a multi-minute
 * wait was being cut off by the client while the server was still holding the
 * turn open — surfacing as `MCP error -32001: Request timed out` rather than
 * as an answer. Derive the client's timeout from the tool's own wait, with
 * slack, so the server's timeout is the one that fires.
 */
const toolWaitMs = Number(toolArguments['wait_ms'] ?? toolArguments['timeout_ms'] ?? 0)
const requestTimeoutMs = Math.max(60_000, toolWaitMs + 30_000)
const result = await client.callTool({ name: tool, arguments: toolArguments }, undefined, {
  timeout: requestTimeoutMs,
  maxTotalTimeout: requestTimeoutMs,
})
/*
 * The SDK types `content` as a union of block kinds, and only the text block
 * carries `text`. Narrowing rather than asserting keeps a non-text reply from
 * printing "undefined" and looking like an empty answer.
 */
const content: unknown[] = Array.isArray(result.content) ? result.content : []
const first = content[0] as { type?: string; text?: string } | undefined
console.log(first?.type === 'text' ? first.text : JSON.stringify(result.content, null, 2))
await client.close()
process.exit(result.isError ? 1 : 0)

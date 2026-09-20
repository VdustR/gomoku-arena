/**
 * A one-shot MCP client, so a seat can be driven from a shell.
 *
 *   node scripts/mcp-cli.mjs <tool> '<json args>'
 *
 * It is the same Streamable HTTP client a harness uses, which makes it a
 * convenient way to check the server by hand.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const [tool, ...rest] = process.argv.slice(2)
if (!tool) {
  console.error("usage: node scripts/mcp-cli.mjs <tool> '<json args>'")
  process.exit(2)
}
/*
 * The endpoint, in the order of how much the caller meant it: an explicit
 * `GOMOKU_MCP_URL`, then whatever portless is serving this under, then the
 * default port. `PORTLESS_URL` carries its own scheme, so this works the
 * same whether the proxy is running HTTPS or `--no-tls`.
 */
const portless = process.env.PORTLESS_URL
const url = process.env.GOMOKU_MCP_URL ?? (portless ? `${portless}/mcp` : 'http://localhost:5273/mcp')
const client = new Client({ name: process.env.MCP_CLIENT_NAME ?? 'mcp-cli', version: '1.0.0' })
await client.connect(new StreamableHTTPClientTransport(new URL(url)))
const result = await client.callTool({ name: tool, arguments: JSON.parse(rest.join(' ') || '{}') })
console.log(result.content[0].text)
await client.close()
process.exit(result.isError ? 1 : 0)

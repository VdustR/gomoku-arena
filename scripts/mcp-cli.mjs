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
const url = process.env.GOMOKU_MCP_URL ?? 'http://localhost:5273/mcp'
const client = new Client({ name: process.env.MCP_CLIENT_NAME ?? 'mcp-cli', version: '1.0.0' })
await client.connect(new StreamableHTTPClientTransport(new URL(url)))
const result = await client.callTool({ name: tool, arguments: JSON.parse(rest.join(' ') || '{}') })
console.log(result.content[0].text)
await client.close()
process.exit(result.isError ? 1 : 0)

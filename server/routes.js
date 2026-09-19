/**
 * One request pipeline, shared by the dev server and `npm start`, so both
 * behave identically: relay, match API, MCP.
 */

import { handleRelay } from './relay.js'
import { handleApi } from './api.js'
import { handleMcpRequest } from './mcp.js'

const MCP_PATH = '/mcp'

/** True when this request was answered here. */
export async function handleServerRoutes(req, res) {
  const path = (req.url ?? '/').split('?')[0]

  if (path === MCP_PATH || path.startsWith(`${MCP_PATH}/`)) {
    await handleMcpRequest(req, res)
    return true
  }
  if (await handleRelay(req, res)) return true
  if (await handleApi(req, res)) return true

  // An unknown path under /api/ is an error, not a page. Falling through to
  // the single-page fallback would answer a fetch with HTML.
  if (path.startsWith('/api/')) {
    res.statusCode = 404
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ error: 'no_such_route', message: `No route for ${req.method} ${path}.` }))
    return true
  }

  return false
}

/** The same pipeline as a Vite dev-server plugin. */
export function serverRoutesPlugin() {
  return {
    name: 'gomoku-server-routes',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        try {
          const handled = await handleServerRoutes(req, res)
          if (!handled) next()
        } catch (error) {
          next(error)
        }
      })
    },
  }
}

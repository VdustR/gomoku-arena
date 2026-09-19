/**
 * One request pipeline, shared by the dev server and `npm start`, so both
 * behave identically: relay, match API, MCP.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleRelay } from './relay.ts'
import { handleApi } from './api.ts'
import { handleMcpRequest } from './mcp.ts'

const MCP_PATH = '/mcp'

/**
 * The shape of a dev server, as much of it as this plugin touches.
 *
 * Vite is bundled inside Vite+ rather than declared as a dependency here, so
 * there is no `vite` package to import a type from. Naming the two members
 * actually used is more honest than an `any` and does not pretend to describe
 * the rest of the interface.
 */
interface DevServer {
  middlewares: {
    use(handler: (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => void): void
  }
}

/** True when this request was answered here. */
export async function handleServerRoutes(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = (req.url ?? '/').split('?')[0] ?? '/'

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
    configureServer(server: DevServer) {
      server.middlewares.use((req, res, next) => {
        void (async () => {
          try {
            const handled = await handleServerRoutes(req, res)
            if (!handled) next()
          } catch (error) {
            next(error)
          }
        })()
      })
    },
  }
}

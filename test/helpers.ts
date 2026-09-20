/**
 * Shared test plumbing.
 *
 * Tests that need a real server used to bind a fixed port, which meant a
 * leftover process from an earlier run silently answered instead — the tests
 * then checked yesterday's code. Asking the OS for a free port removes that.
 */

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** A port nothing is listening on right now. */
export function freePort(): Promise<number> {
  return new Promise((ready, failed) => {
    const probe = createServer()
    probe.once('error', failed)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo
      probe.close(() => ready(port))
    })
  })
}

/** One server this suite started, and the handle to stop it again. */
export interface TestServer {
  child: ChildProcess
  port: number
  base: string
  stateDir: string
  stop: () => Promise<void>
}

/**
 * Start the app server on its own port, with its own state directory, and
 * wait until it answers.
 *
 * Matches now survive a restart, which means a server sharing the default
 * store would also inherit every match an earlier run left behind. A suite
 * that counts matches would then be counting last week's.
 */
export async function startServer(env: Record<string, string> = {}): Promise<TestServer> {
  const port = await freePort()
  const stateDir = env['GOMOKU_STATE_DIR'] ?? mkdtempSync(join(tmpdir(), 'gomoku-test-'))
  const child = spawn(process.execPath, ['server/index.ts'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), GOMOKU_STATE_DIR: stateDir, ...env },
    stdio: 'ignore',
  })
  // A directory this helper created is this helper's to remove.
  if (!env['GOMOKU_STATE_DIR']) {
    child.once('exit', () => rmSync(stateDir, { recursive: true, force: true }))
  }
  const base = `http://127.0.0.1:${port}`
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      await fetch(`${base}/api/matches`)
      return { child, port, base, stateDir, stop: () => stop(child) }
    } catch {
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  child.kill()
  throw new Error('server did not start')
}

export const stop = (child: ChildProcess): Promise<void> =>
  new Promise((done) => {
    child.once('exit', () => done())
    child.kill()
  })

/** A JSON call against a running test server, with the status kept. */
export async function fetchJson<T>(
  base: string,
  path: string,
  options: RequestInit = {},
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${base}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...options,
  })
  return { status: response.status, body: (await response.json()) as T }
}

/**
 * An error body as the API returns one.
 *
 * The suites assert on refusals as often as on successes, and a refusal is
 * not the shape the success type describes.
 */
export interface ApiError {
  error: string
  message?: string
  [key: string]: unknown
}

/*
 * One MCP client, connected.
 *
 * The SDK's own transport is not assignable to the `Transport` its `connect`
 * takes once `exactOptionalPropertyTypes` is on: the class types its optional
 * members as `T | undefined` and the interface declares them as optional,
 * which that flag treats as different types. The mismatch is upstream and
 * entirely in the type shape — this is the transport the SDK tells callers to
 * use — so it is narrowed in this one place rather than at every call site or
 * by relaxing the flag for the whole project.
 */
export async function connectMcp(base: string, name: string): Promise<Client> {
  const client = new Client({ name, version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)) as Transport)
  return client
}

/**
 * The first text block of a tool result, parsed. Tool results are JSON text.
 *
 * The parameter is `unknown` rather than a shape with a `content` field: the
 * SDK's result type carries an index signature, and under
 * `exactOptionalPropertyTypes` that is not assignable to an object type
 * declaring `content` as optional. Narrowing inside is both simpler and
 * closer to the truth, since the caller cannot promise what came back.
 */
export function toolPayload<T>(result: unknown): T {
  const blocks = (result as { content?: unknown } | null)?.content
  const content: unknown[] = Array.isArray(blocks) ? blocks : []
  const first = content[0] as { type?: string; text?: string } | undefined
  return JSON.parse(first?.type === 'text' ? (first.text ?? '{}') : '{}') as T
}

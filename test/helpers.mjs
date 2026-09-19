/**
 * Shared test plumbing.
 *
 * Tests that need a real server used to bind a fixed port, which meant a
 * leftover process from an earlier run silently answered instead — the tests
 * then checked yesterday's code. Asking the OS for a free port removes that.
 */

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** A port nothing is listening on right now. */
export function freePort() {
  return new Promise((ready, failed) => {
    const probe = createServer()
    probe.once('error', failed)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => ready(port))
    })
  })
}

/**
 * Start the app server on its own port, with its own state directory, and
 * wait until it answers.
 *
 * Matches now survive a restart, which means a server sharing the default
 * store would also inherit every match an earlier run left behind. A suite
 * that counts matches would then be counting last week's.
 */
export async function startServer(env = {}) {
  const port = await freePort()
  const stateDir = env.GOMOKU_STATE_DIR ?? mkdtempSync(join(tmpdir(), 'gomoku-test-'))
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), GOMOKU_STATE_DIR: stateDir, ...env },
    stdio: 'ignore',
  })
  // A directory this helper created is this helper's to remove.
  if (!env.GOMOKU_STATE_DIR) {
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

export const stop = (child) =>
  new Promise((done) => {
    child.once('exit', done)
    child.kill()
  })

/** A tiny PASS/FAIL reporter shared by the suites. */
export function reporter() {
  let pass = 0
  let fail = 0
  return {
    check(name, actual, expected) {
      const ok = JSON.stringify(actual) === JSON.stringify(expected)
      ok ? (pass += 1) : (fail += 1)
      console.log(
        `${ok ? 'PASS' : 'FAIL'}  ${name}` +
          (ok ? '' : `\n      expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`),
      )
    },
    truthy(name, value, detail = '') {
      value ? (pass += 1) : (fail += 1)
      console.log(`${value ? 'PASS' : 'FAIL'}  ${name}${value ? '' : `\n      ${detail}`}`)
    },
    done() {
      console.log(`\n${pass} passed, ${fail} failed`)
      process.exit(fail ? 1 : 0)
    },
  }
}

import { svelte } from '@sveltejs/vite-plugin-svelte'
import { serverRoutesPlugin } from './server/routes.ts'

/**
 * The host portless is serving this under, if it is.
 *
 * `PORTLESS_URL` carries the whole public URL including the scheme, so the
 * same line works whether the proxy is running HTTPS or `--no-tls`. Vite
 * refuses a Host header it was not told about, and the name portless picks
 * depends on `portless.json`, the directory and the worktree — so it is read
 * rather than guessed.
 */
function portlessHosts(): string[] {
  const url = process.env['PORTLESS_URL']
  if (!url) return []
  try {
    return [new URL(url).hostname]
  } catch {
    return []
  }
}

export default {
  plugins: [svelte(), serverRoutesPlugin()],
  /*
   * Type checking is Vite+'s, not a second toolchain's.
   *
   * `vp check` runs the type-aware path through tsgolint against
   * `tsconfig.json`, so the strict settings there are what is enforced.
   * Verified rather than assumed: with `typeCheck` off, a deliberate
   * `const n: number = 'not a number'` passed.
   */
  lint: { options: { typeAware: true, typeCheck: true } },
  /*
   * The house style, stated so the formatter enforces it rather than fighting
   * it. No semicolons and single quotes are what every file already used;
   * `printWidth` was picked by measuring, not by taste — 110 moves the fewest
   * lines of the widths tried, because it is close to where this code was
   * already being wrapped by hand.
   */
  fmt: { semi: false, singleQuote: true, printWidth: 110 },
  /*
   * Vitest is the runner Vite+ already bundles, so the suites need no second
   * toolchain. `node` rather than a DOM: every suite here drives the rules,
   * the server or the relay, and the one that touches a browser API stubs it.
   * The generous timeouts are for the suites that spawn a real server and
   * wait for it to answer.
   */
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  server: {
    /*
     * 5273 is the default, not the rule. Under portless the app is given a
     * random port through `PORT` and reached by name instead, so reading the
     * environment is what lets one config serve both ways of running.
     */
    port: Number(process.env['PORT']) || 5273,
    // *.localhost resolves to loopback in Chromium; allow the vanity host,
    // plus whatever name portless is actually serving this under.
    allowedHosts: ['gomoku.localhost', 'localhost', '127.0.0.1', ...portlessHosts()],
  },
}

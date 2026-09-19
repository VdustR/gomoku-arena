import { svelte } from '@sveltejs/vite-plugin-svelte'
import { serverRoutesPlugin } from './server/routes.ts'

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
  server: {
    port: 5273,
    // *.localhost resolves to loopback in Chromium; allow the vanity host.
    allowedHosts: ['gomoku.localhost', 'localhost', '127.0.0.1'],
  },
}

import { svelte } from '@sveltejs/vite-plugin-svelte'
import { serverRoutesPlugin } from './server/routes.js'

export default {
  plugins: [svelte(), serverRoutesPlugin()],
  server: {
    port: 5273,
    // *.localhost resolves to loopback in Chromium; allow the vanity host.
    allowedHosts: ['gomoku.localhost', 'localhost', '127.0.0.1'],
  },
}

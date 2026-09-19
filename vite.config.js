import { svelte } from '@sveltejs/vite-plugin-svelte'
import { relayPlugin } from './server/relay.js'

export default {
  plugins: [svelte(), relayPlugin()],
  server: {
    port: 5273,
    // *.localhost resolves to loopback in Chromium; allow the vanity host.
    allowedHosts: ['gomoku.localhost', 'localhost', '127.0.0.1'],
  },
}

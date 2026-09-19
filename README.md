# Gomoku Arena

A gomoku board that any model can sit at.

Play it yourself, hand a side to an engine, or put two engines opposite each
other — and watch every decision arrive with the moves it was choosing
between, how confident it was, and how long it took.

The board is the constant. The engines are pluggable, and adding a new kind of
model is a single adapter, not a rewrite.

## Quick start

```sh
npm install
npm run dev
```

Open <http://gomoku.localhost:5273>. Any `*.localhost` host resolves to
loopback in Chromium-based browsers; plain `localhost` works too.

To serve the built page instead:

```sh
npm run build
npm start
```

Both paths need a server of your own — see [Why a server is
required](#why-a-server-is-required).

## Providers

| Provider | Needs a key | Where it runs |
| --- | --- | --- |
| Chrome built-in AI | No | On-device, via the [Prompt API](https://developer.chrome.com/docs/ai/prompt-api). No network at all. |
| Jev-compatible | Yes | Any endpoint serving `POST <base>/systemone` |
| OpenAI-compatible | Yes | Any endpoint serving `POST <base>/chat/completions` |
| Built-in heuristic | No | Pattern scoring inside the page |

When Chrome's built-in model is available it takes the default AI seat, ahead
of every remote provider: it costs nothing and never leaves the machine. Set
`VITE_PREFER_BROWSER_MODEL=false` to change that.

Both remote providers take a base URL, so either can point at a hosted service
or at something on your own machine. Settings ships one-click presets for the
three implementations of the Jev wire API:

| Preset | Base URL | Model |
| --- | --- | --- |
| TypeSafe | `https://api.typesafe.ai/v1` | `jev-latest` |
| [localjev](https://github.com/githubnext/localjev) | `http://127.0.0.1:8080/v1` | `localjev-latest` |
| [openjev](https://github.com/razorback16/openjev) | `http://127.0.0.1:8000/v1` | `openjev-latest` |

All three accept `jev-latest`, so the default model reaches any of them.

## Bring your own key

Nothing ships with a key and there is no default. Open **Settings**, paste one
per provider, and it is written to that browser's `localStorage` and sent only
with the request it pays for. **Forget everything** clears it.

A key is never baked into the bundle. If you run the server for yourself and
would rather not type one, put it in `GOMOKU_JEV_KEY` or `GOMOKU_OPENAI_KEY`
instead: the relay reads those and the browser never sees them.

A server key must be paired with `GOMOKU_JEV_BASE_URL` or
`GOMOKU_OPENAI_BASE_URL`. A server key is spent on the caller's behalf, so the
caller does not get to choose where it is spent — otherwise anyone who could
reach the server could point the base URL at a host they control and collect
the key. When the server supplies the key it supplies the destination too, and
the relay refuses to start a request if only one of the pair is set. A key
typed into the page belongs to whoever typed it, so that request still names
its own endpoint. `test/relay.test.mjs` holds this behaviour in place.

Even so, anyone who can reach a server configured this way can spend those
keys. Do not do it on a shared host.

## Configuration

Copy `.env.example` to `.env`. Every value is optional.

`VITE_*` is read at build time and **baked into the bundle every visitor
downloads**. Never put a credential in one.

| Variable | Default | What it does |
| --- | --- | --- |
| `VITE_JEV_BASE_URL` | `https://api.typesafe.ai/v1` | Default Jev-compatible endpoint |
| `VITE_JEV_MODEL` | `jev-latest` | Default Jev model |
| `VITE_OPENAI_BASE_URL` | `https://api.openai.com/v1` | Default OpenAI-compatible endpoint |
| `VITE_OPENAI_MODEL` | `gpt-4o-mini` | Default chat model |
| `VITE_DEFAULT_RULE_SET` | `free` | `free` or `renju` |
| `VITE_DEFAULT_MATCH` | `pvc` | `pvp`, `pvc`, or `cvc` |
| `VITE_PREFER_BROWSER_MODEL` | `true` | Give the on-device model the default AI seat |
| `VITE_CANDIDATE_LIMIT` | `8` | How many moves an engine chooses between (2–24) |
| `VITE_AI_MOVE_DELAY_MS` | `260` | A beat before an engine moves (0–5000) |
| `VITE_STORAGE_KEY` | `gomoku.settings` | Where browser-held settings live |

The rest stay on the server and never reach the page:

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `5273` | Port for `npm start` |
| `HOST` | `127.0.0.1` | Interface for `npm start` |
| `GOMOKU_JEV_KEY` | unset | Relay fallback when the page sends no key |
| `GOMOKU_JEV_BASE_URL` | unset | Required with `GOMOKU_JEV_KEY`; pins where that key is spent |
| `GOMOKU_OPENAI_KEY` | unset | Relay fallback when the page sends no key |
| `GOMOKU_OPENAI_BASE_URL` | unset | Required with `GOMOKU_OPENAI_KEY` |
| `GOMOKU_UPSTREAM_TIMEOUT_MS` | `60000` | How long the relay waits upstream |
| `GOMOKU_ALLOW_INSECURE_HTTP` | `false` | Permit plain http to a non-loopback endpoint |

## Why a server is required

Remote inference endpoints refuse browser origins, so a purely static page
cannot reach them. TypeSafe answers `400 Disallowed CORS origin` to every
origin tested — `http://localhost`, `http://127.0.0.1`, `https://localhost`,
`http://gomoku.localhost`, `https://console.typesafe.ai`, and `null` — with no
`access-control-allow-origin` header on any of them.

`server/relay.js` forwards one request and keeps no copy of the key. It backs
both `npm run dev` (as Vite middleware) and `npm start` (as a plain Node
server), so the two behave identically. It accepts `https`, or `http` on
localhost; plain http anywhere else takes `GOMOKU_ALLOW_INSECURE_HTTP=true`,
because it would put the key on the wire in the clear.

Chrome's built-in model and the heuristic never touch it.

## Rules

- **Free style** — five or more in a row wins. No restrictions on either
  player. Note that free-style gomoku on 15×15 is a proven first-player win.
- **Renju** — tournament rules, which restrict black to compensate. Black may
  not play an overline, a double four, or a double three; such a move loses
  the game. A move that makes exactly five wins outright and is never
  forbidden. White plays unrestricted.

A forbidden point is marked on the board before you commit to it, rather than
rejected after the fact.

## Tests

```sh
npm test
```

Three suites, no network needed:

| Suite | Covers |
| --- | --- |
| `test/rules.test.mjs` | Five, overline, double four, double three, board edges, both rule sets |
| `test/providers.test.mjs` | Reading a move index out of whatever a model replied with |
| `test/relay.test.mjs` | Key handling and endpoint pinning, against a live server |

## How a move is chosen

No engine is asked to invent a coordinate.

1. The page scores the position and builds a shortlist of **legal** moves,
   each with a plain description of what it does — `H8 — makes an open three
   and blocks the opponent's four`.
2. The provider picks one entry from that shortlist.
3. The move is applied.

An illegal move cannot reach the board whatever the engine replies, and a move
that wins or prevents an immediate loss is played without a round trip. Every
provider answers the same narrowed question over the same candidates, so the
comparison between them is like-for-like.

## Adding a provider

A provider is one async function in `src/lib/ai/providers.js`. It receives the
position and the shortlist, and returns the chosen candidate plus whatever it
can say about the decision:

```js
async function myMove({ position, candidates, key, config, signal }) {
  const chosen = await somehowPick(position, candidates)
  return {
    move: chosen,
    latencyMs: 42,
    telemetry: {
      provider: MY_ID,
      model: 'my-model-1',
      confidence: 0.8,                                  // optional
      ranked: candidates.map((c) => ({ label: c.label, weight: 0 })),
      usage: { input_tokens: 0 },                       // optional
      notes: 'How this engine reached the move.',
    },
  }
}
```

Register it in `PROVIDERS`, add a branch in `chooseMove`, and the seat picker,
the telemetry panel, and the move log pick it up unchanged. Nothing about the
board, the rules, or the UI is specific to any one vendor.

## Project layout

```
index.html              Document head: metadata, fonts, JSON-LD
src/lib/rules.js        Board, win detection, renju forbidden moves
src/lib/config.js       Build-time configuration from VITE_*
src/lib/settings.svelte.js  Browser-held settings (localStorage)
src/lib/game.svelte.js  Game state, seats, move log
src/lib/ai/heuristic.js Candidate generation and the offline engine
src/lib/ai/providers.js Provider registry and adapters
src/components/         Board, telemetry panel, settings dialog
server/relay.js         Shared relay: Vite middleware and Node handler
server/index.js         `npm start`: serves dist/ and the relay
test/                   Rules, reply parsing, and relay behaviour
```

## License

[MIT](LICENSE) © ViPro (VdustR)

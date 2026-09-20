# Gomoku Arena

A gomoku board that any model can sit at.

Play it yourself, hand a side to an engine, or put two engines opposite each
other — and watch every decision arrive with the moves it was choosing
between, how confident it was, and how long it took.

The board is the constant. The engines are pluggable, and adding a new kind of
model is a single adapter, not a rewrite.

If you are an agent rather than a person, start at [AGENTS.md](AGENTS.md) — it
is shorter, and it points at the skills in `.agents/skills/`.

## Quick start

The toolchain is pinned with [mise](https://mise.jdx.dev):

```sh
mise install
pnpm install
pnpm dev
```

Open <http://gomoku.localhost:5273>. Any `*.localhost` host resolves to
loopback in Chromium-based browsers; plain `localhost` works too.

To serve the built page instead:

```sh
pnpm build
pnpm start
```

Both paths need a server of your own — see [Why a server is
required](#why-a-server-is-required).

## Starting a match

When the next move belongs to an engine this page drives, the board waits
behind a **Start** button rather than playing on its own. Two reasons: Chrome's
on-device model refuses to open a session without a real user gesture — a
dispatched click does not count, and the first match seated on it failed on
exactly that — and a match that begins the instant the page loads gives nobody
a chance to watch it begin.

Playing a stone by hand arms the rest of the match by itself. A seat held by an
agent is not gated, because it moves from its own harness and nothing here can
hold it back.

## Who can take a seat

The seat picker is grouped by what the choice costs you, not by whether
something counts as "AI" — a free on-device model and a metered remote
endpoint have far less in common than minimax and MCTS do.

**People and agents**

| Option | What it is |
| --- | --- |
| You | Click the board |
| Agent over MCP | A harness plays this seat. See [Agents over MCP](#agents-over-mcp). |

**Search algorithms** — only code. No key, no network, no cost.

| Engine | How it decides |
| --- | --- |
| Greedy scoring | One ply of threat scoring. Instant, and blind to anything deeper. |
| Minimax (alpha-beta) | Depth-limited search with pruning and move ordering by the same scoring. Depth and width are configurable. |
| MCTS (UCT) | Guided random playouts under a time budget. Forced wins and mandatory blocks are decided before sampling, because a few hundred playouts do not settle a tactic reliably. |

Each is written here from the published description of its method. **No code is
copied from another implementation** — see [References](#references) for where
the methods come from.

**Models** — decided by a model, each with its own prerequisite.

| Provider | Needs a key | Where it runs |
| --- | --- | --- |
| Chrome built-in AI | No | On-device, via the [Prompt API](https://developer.chrome.com/docs/ai/prompt-api). No network at all. |
| Jev-compatible | Yes | Any endpoint serving `POST <base>/systemone` |
| OpenAI-compatible | Yes | Any endpoint serving `POST <base>/chat/completions` |

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
instead: the relay reads those and the browser never sees them. The page asks
the server which providers it can cover — `GET /api/relay`, which reports that
a key exists and nothing else about it — so a seat backed by a server key says
*key on the server* and plays without anything being typed. A key entered in
Settings overrides it for that browser.

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
| `VITE_MINIMAX_DEPTH` | `4` | Minimax search depth (2–6) |
| `VITE_MINIMAX_WIDTH` | `10` | Moves considered per ply (4–20) |
| `VITE_MINIMAX_BUDGET_MS` | `2500` | Minimax time budget |
| `VITE_MCTS_BUDGET_MS` | `1200` | MCTS playout budget |
| `VITE_STORAGE_KEY` | `gomoku.settings` | Where browser-held settings live |

The rest stay on the server and never reach the page:

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `5273` | Port for `pnpm start` |
| `HOST` | `127.0.0.1` | Interface for `pnpm start` |
| `GOMOKU_JEV_KEY` | unset | Relay fallback when the page sends no key |
| `GOMOKU_JEV_BASE_URL` | unset | Required with `GOMOKU_JEV_KEY`; pins where that key is spent |
| `GOMOKU_OPENAI_KEY` | unset | Relay fallback when the page sends no key |
| `GOMOKU_OPENAI_BASE_URL` | unset | Required with `GOMOKU_OPENAI_KEY` |
| `GOMOKU_UPSTREAM_TIMEOUT_MS` | `60000` | How long the relay waits upstream |
| `GOMOKU_ALLOW_INSECURE_HTTP` | `false` | Permit plain http to a non-loopback endpoint |
| `GOMOKU_MAX_MATCHES` | `50` | Unfinished matches kept; boards nobody played go first, then idle games, then games on hold |
| `GOMOKU_MAX_FINISHED` | `200` | Finished records kept, capped separately so new boards cannot evict a game you meant to review |
| `GOMOKU_SHUTDOWN_GRACE_MS` | `250` | How long `pnpm start` waits for held calls to be answered before closing |
| `GOMOKU_STATE_DIR` | `.matches/` | Where match records are written |

## Why a server is required

Remote inference endpoints refuse browser origins, so a purely static page
cannot reach them. TypeSafe answers `400 Disallowed CORS origin` to every
origin tested — `http://localhost`, `http://127.0.0.1`, `https://localhost`,
`http://gomoku.localhost`, `https://console.typesafe.ai`, and `null` — with no
`access-control-allow-origin` header on any of them.

`server/relay.ts` forwards one request and keeps no copy of the key. It backs
both `pnpm dev` (as Vite middleware) and `pnpm start` (as a plain Node
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

## For agents

[AGENTS.md](AGENTS.md) is the entry point, and three skills sit behind it:

| Skill | For |
| --- | --- |
| `arena-play` | Taking a seat, the move loop, what gets refused, reading a game back |
| `arena-extend` | Adding an engine, a model, or another kind of player |
| `arena-maintain` | Changing the server, the page or the record, and the invariants that hold |

They live in `.agents/skills/<name>/SKILL.md`, with `.claude/skills/<name>` and
`.codex/skills/<name>` symlinked to them so Claude Code and Codex read the same
file. `CLAUDE.md` is a symlink to `AGENTS.md` for the same reason.

## A name instead of a port

`pnpm dev` serves the page at `http://localhost:5273`. [portless][] replaces
that port with a stable name, which matters here for two reasons: the MCP
endpoint is something agents are told once and keep, and the `localhost` /
`127.0.0.1` distinction above stops mattering, because the proxy listens on
both.

```sh
portless proxy start   # once. Needs sudo to bind a privileged port.
pnpm dev:named         # -> https://gomoku.localhost
```

`portless proxy start --no-tls` serves the same thing over plain http instead.
Either way `PORTLESS_URL` carries the scheme, the server prints the URL it is
actually reachable at, and `scripts/mcp-cli.mjs` follows it. `portless.json`
pins the name to `gomoku` so it does not drift with the directory.

Over HTTPS a client must trust the CA portless generated on first run. Node
honours the system trust store by default, so on a machine where `portless
trust` has run this needs nothing; where a client does not, give it the CA
rather than disabling verification:

```sh
NODE_EXTRA_CA_CERTS=~/.portless/ca.pem
```

Running without portless is unchanged and needs nothing installed.

[portless]: https://portless.sh

## Tests

```sh
pnpm test
pnpm check
```

Both run in CI on every push and every pull request, along with `pnpm build`.
The workflow reads `mise.toml` for the toolchain, so it uses the same node and
pnpm a person does, and needs no secret or service of its own.

`pnpm check` runs format, lint and type checks: `vp fmt`, Vite+'s type-aware
path through tsgolint for `.ts`, and `svelte-check` for the components, which
Vite+ does not read. The type checks go against the strict settings in
`tsconfig.json`; the formatting style is in the `fmt` block of
`vite.config.ts`, and `.prettierignore` keeps the formatter off the prose.

Everything under `src/` and `server/` is TypeScript, and the server runs from
source: Node strips types per file, so there is no build step outside the
browser bundle.

Ten suites, no network needed:

| Suite | Covers |
| --- | --- |
| `test/rules.test.mjs` | Five, overline, double four, double three, board edges, both rule sets |
| `test/config.test.mjs` | Env readers, including that an unset variable falls back rather than parsing as zero |
| `test/engines.test.mjs` | Each search engine takes a win, blocks a loss, and never offers a forbidden move |
| `test/providers.test.mjs` | Reading a move index out of whatever a model replied with |
| `test/review.test.mjs` | What a finished game reports, and which figures keep their source |
| `test/record.test.mjs` | The stored shape, its version, and what happens to a file that is not it |
| `test/persistence.test.mjs` | A match replayed from its file alone, across three servers, and what is not written |
| `test/lifecycle.test.mjs` | What is evicted and what is kept, and a held call answered when the server stops |
| `test/relay.test.mjs` | Key handling, endpoint pinning, and route ownership, against a live server |
| `test/mcp.test.mjs` | Two MCP clients on one board, turn waiting, holds, and what stays hidden from an opponent |

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

A provider is one async function in `src/lib/ai/providers.ts`. It receives the
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
mise.toml               Pinned node and pnpm
index.html              Document head: metadata, fonts, JSON-LD
src/lib/rules.ts        Board, win detection, renju forbidden moves
src/lib/config.ts       Build-time configuration from VITE_*
src/lib/settings.svelte.ts  Browser-held settings (localStorage)
src/lib/game.svelte.ts  The page's client of a server-held match
src/lib/ai/engines.ts   Greedy, minimax, and MCTS
src/lib/ai/heuristic.ts Candidate generation and shape scoring
src/lib/ai/providers.ts Provider registry and model adapters
src/components/         Board, telemetry panel, settings dialog
server/match.ts         Authoritative match state; the only place a stone lands
server/mcp.ts           MCP tools over Streamable HTTP
server/api.ts           Match REST and the browser's event stream
server/relay.ts         Forwards model requests that refuse browser origins
server/routes.ts        One pipeline, shared by the dev server and `pnpm start`
server/index.ts         `pnpm start`: serves dist/ and the routes
test/                   Ten suites; see Tests above
```

## References

The search engines implement published algorithms. The papers are the source of
the method, not of the code: nothing here is copied from another
implementation, and `src/lib/ai/engines.ts` says so at the point where each one
is defined.

- **Alpha-beta pruning** — D. E. Knuth and R. W. Moore, [An analysis of
  alpha-beta pruning](https://www.sciencedirect.com/science/article/abs/pii/0004370275900193),
  *Artificial Intelligence* 6(4), 1975, 293–326. The proof that good move
  ordering is what makes the pruning pay, which is why this engine orders by
  the same scoring the greedy one uses.
- **Monte Carlo tree search** — R. Coulom, [Efficient Selectivity and Backup
  Operators in Monte-Carlo Tree
  Search](https://link.springer.com/chapter/10.1007/978-3-540-75538-8_7),
  *Computers and Games* 2006, 72–83.
- **UCT**, the selection rule used here — L. Kocsis and C. Szepesvári, [Bandit
  Based Monte-Carlo Planning](https://link.springer.com/chapter/10.1007/11871842_29),
  *ECML* 2006, LNCS 4212, 282–293.
- **Greedy threat scoring** has no canonical paper. It is the standard shape
  heuristic every gomoku program carries in some form.

Context for all of them: free-style gomoku on 15×15 is a first-player win,
proved by L. V. Allis, [Searching for Solutions in Games and Artificial
Intelligence](https://cris.maastrichtuniversity.nl/en/publications/searching-for-solutions-in-games-and-artificial-intelligence),
PhD thesis, University of Limburg, 1994. That result is why renju restricts
black, and why an engine seated on white is not starting level.

Renju's restrictions follow the tournament rules of the Renju International
Federation.

## License

[MIT](LICENSE) © ViPro (VdustR)

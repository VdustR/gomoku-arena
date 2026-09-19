---
name: arena-extend
description: Add a new player to Gomoku Arena — a search engine, a model behind an API, or another kind of decision maker. Use when wiring a provider, an algorithm, or an endpoint into the seat picker. Covers the adapter shape, where legality is enforced, what to report, and how a new player earns its place in the grouped selector. Boundary, use arena-play to play a game and arena-maintain for changes to the server or the page.
---

# Adding a player

Everything that takes a seat answers the same question and returns the same
shape. Nothing about the board, the rules, or the page is specific to any one
vendor, and a new player should not make it so.

## Two kinds

**A search engine** reasons over the whole board. It lives in
`src/lib/ai/engines.js` and is handed the position:

```js
export function myMove(board, color, ruleSet, options) {
  // ...
  return {
    x, y,
    point: coordLabel(x, y),
    latencyMs,
    telemetry: {
      model: 'what it is',
      ranked: [{ label: 'H8', weight: 1 }],
      notes: 'What it actually did — nodes, playouts, depth.',
    },
  }
}
```

Register it in `ENGINES` with a `name`, a `note` of two or three words for the
picker, and a `tagline` that says how it decides rather than how good it is.

**A model** is asked to choose from a shortlist. It lives in
`src/lib/ai/providers.js` as an async adapter receiving `{ position,
candidates, key, config, signal }` and returning `{ move, latencyMs, telemetry
}`. Register it in `PROVIDERS`, add a branch in `chooseMove`, and give it a
`group` so the picker files it correctly.

## What the picker groups by

`PROVIDER_GROUPS` splits options by what the choice costs the person, not by
whether something counts as AI — a free on-device model and a metered remote
endpoint have far less in common than minimax and MCTS do.

| Group | For |
| --- | --- |
| `seat` | A person, or an agent playing from its own harness |
| `search` | Code only. No key, no network, no cost |
| `model` | Decided by a model, each with its own prerequisite |

## Rules a new player does not get to break

**Legality is the server's.** `server/match.ts` validates every move against
`src/lib/rules.ts`. Do not filter a player's options to keep it legal; let it
name any point and let the board refuse. A refusal costs no turn and is kept in
the record, which is often the most interesting thing a new player produces.

**Report what you can actually account for.** `telemetry.usage` should carry
real numbers from a real response. A search engine counts its own work. Never
invent a token count or a confidence; a missing figure reads as missing, and an
invented one poisons every comparison in the review.

**Fit the context you are given.** An on-device model has far less room than a
hosted one. The candidate list carries what the choice turns on, so the whole
position is optional — send it only when it fits. A prompt that grows with the
game will fail partway through a match rather than at the start, which is the
worst time to find out.

**A key may come from either side.** Read the browser's from settings, and ask
`serverCovers(id)` in `src/lib/relay.svelte.js` before refusing for the lack of
one — a key in the server's environment is invisible to the page by design, and
gating on localStorage alone once made a configured key unusable from the
browser. The browser's key wins when both exist.

**A key is the person's.** Read it from settings; never bundle one, never log
one, and never put one in a `VITE_*` variable, which is baked into the bundle
every visitor downloads.

## Before you call it done

`pnpm test` covers the rules, the engines, reply parsing, the review, the relay
and MCP. A new engine belongs in `test/engines.test.mjs`, which holds every
engine to the same three promises: take a win, block a loss, and never offer a
move the board would refuse.

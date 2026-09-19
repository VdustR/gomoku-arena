# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Vite+ (`vite-plus` 0.3.3, CLI `vp`) with Svelte 5 runes, chosen by the user.
`server/relay.js` is shared by the Vite dev server and a plain Node server
(`npm start`), so development and the built page behave identically.

## Users

One person at a desk evaluating AI providers. They already have, or can get,
an API key and want to see how a given engine behaves on a task with an
unambiguous right answer, rather than reading a benchmark table.

## Product Purpose

A gomoku board that any AI can sit at. It exists to make provider behavior
observable: which move an engine chose, what it was choosing between, how
confident it was, and how long it took. The game is the instrument, not the
point.

## Positioning

Every engine answers the same narrowed question over the same shortlist, so
the comparison is like-for-like. An on-device model, a typed decision model,
and a chat model are interchangeable behind one interface — and a hosted
endpoint can be swapped for a local one without touching the game.

## Operating Context

A page served from a server the person starts themselves, either the dev
server or `npm start`. They supply their own key per provider; remote calls
pass through the relay because the endpoints refuse browser origins.

## Capabilities and Constraints

- Three match types: human vs human, human vs engine, engine vs engine.
- Two rule sets: free style, and renju with black's overline, double-four, and
  double-three restrictions.
- Four providers: Chrome's built-in Prompt API, any Jev-compatible endpoint,
  any OpenAI-compatible endpoint, and an in-page heuristic that needs no key.
- Both remote providers take a base URL, so either can point at a hosted
  service or a local one. Jev presets cover TypeSafe, localjev, and openjev.
- Chrome's built-in model takes the default seat whenever it is available,
  because it costs nothing and leaves the machine untouched.
- Keys are held in `localStorage` only. Nothing ships with a key, and the
  relay never writes one to disk or logs it.
- A server-side key (`GOMOKU_*_KEY`) must be paired with a pinned base URL.
  The caller supplies the destination only when the caller supplied the key.
- Every setting is overridable by environment variable. `VITE_*` is public and
  holds no credentials; `GOMOKU_*` stays on the server.
- The model never produces a coordinate. Code generates the legal shortlist;
  the model selects from it. An illegal move cannot reach the board.
- Verified: TypeSafe returns `400 Disallowed CORS origin` to every browser
  origin tested, including its own console, which is why a server is required.
- Verified: `api.openai.com` does return `access-control-allow-origin` for a
  browser origin. It is routed through the relay anyway so that both remote
  providers behave the same way and report the same timing.

## Evidence on Hand

- `test/rules.test.mjs` — 14 assertions covering both rule sets, run with
  `node test/rules.test.mjs`.
- Relay verified end to end against `jev-1.13.0` through `npm start`:
  HTTP 200, 710 ms, real probabilities returned.
- `/api/jev` verified against both a hosted base URL (TypeSafe, 736 ms) and a
  loopback one (a stand-in server on `http://127.0.0.1:8080/v1`, 9 ms), with
  the Authorization header and requested model forwarded intact.
- Verified: localjev and openjev both route `POST /v1/systemone` and accept
  `jev-latest` as a model alias, so the default configuration reaches either.
- A non-loopback `http` base URL is refused by the relay.
- Path traversal against the static server refused: `/../package.json`,
  `/%2e%2e/package.json`, and `/../../etc/passwd` all fall back to the entry
  document with no file contents leaked.
- 34 assertions across three suites, all passing, none needing network.
- An engine-vs-engine match played to completion in the browser: 74 moves,
  White wins, no errors.
- Chrome's built-in model reports `downloadable` in the browser used for
  development; a ready state was not observed. Untested on a machine where the
  model is already downloaded.

## Product Principles

1. Code owns legality; the model only ever chooses.
2. Show the decision, not just its result — engine, candidates, confidence, latency.
3. No bundled credentials, and no key leaves your machine except to the
   endpoint it pays for.
4. Every provider renders through the same panel, so none of them looks
   special by construction.

## Accessibility & Inclusion

The board is keyboard-operable: arrow keys move the cursor, Enter places a
stone. Status and rejections are announced through a live region.

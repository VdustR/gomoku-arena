---
name: arena-maintain
description: Change Gomoku Arena itself — the server, the page, the record, or the design. Use when editing match state, the MCP surface, the relay, the review, or the interface. Covers the invariants that hold the project together, the test suite, the visual system, and the failures already paid for. Boundary, use arena-play to play a game and arena-extend to add a player.
---

# Working on the arena

## Invariants

These are load-bearing. Each one was paid for.

**The move list is the only stored fact.** `server/match.ts` writes the moves
and nothing derived from them; the board, the side to move, the winner and every
frame a review steps through are replayed. Storing a board alongside the moves
would be two copies of one fact, free to disagree after any change. It also
makes a saved file portable.

The test of whether something may be stored is whether replaying the moves
would produce it. A board, a turn, a winner: replayed, so never written. A
take-back (`rewind`) and a hold (`paused`) are events that happened *to* the
match and leave no trace in the list they produce, so they are written — and
the public `status` folds the hold in rather than a second status being kept
beside the replayed one.

`server/record.ts` makes that enforceable rather than conventional. The stored
schema is strict, so a derived field written alongside the moves fails to load
instead of waiting for a test to notice. Changing the stored shape means
bumping `FORMAT_VERSION` and adding a migration for the version you left
behind; a record from a version with no migration, or from a newer format than
this server reads, is skipped, said out loud, and **left on disk** — dropping
somebody's game because it could not be parsed is worse than refusing to show
it.

**Matches survive a restart.** They once lived only in memory, and editing a
server file reloads the dev server on its own, which ended a live match between
two agents mid-game. Anything that mutates a match must reach `persist`.
A refusal changes no stone, so it needs its own write — that path is easy to
miss and is covered by `test/persistence.test.mjs`.

**Legality lives in the server.** `moveLegality` is the only gate. Narrowing
what a player is offered is assistance for weak models, never the safety
mechanism.

**Nothing claims more than it knows.** Thinking time is measured; metrics are
whatever a player reported and carry their source; a seat label is free text and
is marked as supplied. Do not let a number lose its provenance on the way to the
screen.

**No bundled credentials.** `VITE_*` is public and downloaded by every visitor.
A server key (`GOMOKU_*_KEY`) must be paired with a pinned base URL, or a caller
could redirect it to a host they control and collect it. `test/relay.test.mjs`
holds that in place.

**A held call is answered, not dropped.** An agent in `await_turn` or
`play(wait_ms)` is holding an open HTTP request. A stop that simply exits
leaves it with a transport error, which is neither of the two cases its
instructions cover. `releaseWaiters` answers them first, and `server/index.ts`
calls it on SIGINT and SIGTERM. Anything that ends the process deliberately
must go through there.

## Types

Everything under `src/` and `server/` is TypeScript at the strict settings.
`pnpm check` is the command; run it alongside `pnpm test`.

**Two checkers, because one does not read `.svelte`.** `vp check` runs the
type-aware path through tsgolint against `tsconfig.json`, and `svelte-check`
covers the components. Both were verified rather than assumed: with
`lint.options.typeCheck` off, a deliberate `const n: number = 'not a number'`
passed `vp check`, and the same line inside a component passed it even with
type checking on.

**The server runs from source.** Node strips types per file, so
`node server/index.ts` and the plain-node test suites work with no build step.
That is what `erasableSyntaxOnly` protects: no enums, no namespaces, no
parameter properties, and `import type` where a type is what is meant. An
import names the real file — `./rules.ts`, not `./rules.js`.

**An import names the real file**, and the checker will not catch you if it
does not. TypeScript's bundler resolution maps a `.js` specifier onto the
`.ts` file beside it, so `vp check` passes while Node cannot find the module —
which is exactly how the server came to start only under Vite for one commit.
Grep for `from '…​.js'` after any rename.

**`runes: true` is in `svelte.config.js`**, and it is load-bearing for the
checker rather than for the compiler. Without it `svelte-check` read `$state`
as a store subscription on a local variable named `state` — ninety-nine errors
that were all the same misreading. Avoid naming anything `state` in a
component for the same reason.

**The formatter is not in `pnpm check`.** `vp fmt` wants semicolons and this
project has none anywhere. Adopting oxfmt is a separate decision about the
house style, not something a type conversion should have made.

No `any`. A hard spot is where the modelling is wrong, and the modelling is
what this is for. The exception is a library whose own declarations predate
these settings — the MCP SDK is not built under `exactOptionalPropertyTypes`,
so two casts sit at its edge with a comment saying whose modelling is wrong.

**Two guarantees the server's types now carry.** Both were checked by breaking
them on purpose and watching the check fail, which is the only way to know a
guarantee is one:

- `STATUS` in `server/api.ts` is written `satisfies Record<MatchErrorCode,
  number>`, so a new refusal code with no status is a compile error rather
  than a silent 400.
- `getMatch` returns `MatchState`; only `persist` produces `Saved`, and every
  function that hands a match back returns `Saved`. A path that changes a
  match and returns it without writing does not compile. It does not catch a
  mutation that is dropped rather than returned — that is the refusal path,
  and `refuse()` is the answer to it: one function, and it writes.

## The suite

`pnpm test` runs ten suites and needs no network. Server-backed suites take a
free port and their own state directory; a fixed port once meant a leftover
process answered instead and the suite quietly checked yesterday's code.

Match a new test to the behaviour, not the syntax. A rule change belongs in
`test/rules.test.mjs` with a position that proves it; a transport change belongs
in `test/mcp.test.mjs` with two clients on one board.

## The interface

`DESIGN.md` is the committed visual world and `PRODUCT.md` the product record.
Read both before changing the page, and read the craft floor of whatever design
skill is installed before any UI edit — a start button was once shipped as a
play triangle in a pill across a third of the board, breaking three rules this
project had already written down.

Two habits worth keeping:

- **Every control says what it does to the game.** The panel is grouped by
  consequence: what this match is, how to change a seat in it, how to start
  over. A control that quietly discards a configuration is a bug even when it
  works.
- **Liveness is observed, not guessed.** The server cannot report that an agent
  is thinking, only whose turn it is and when the turn began. The page shows how
  long a side has been on move, which is true, rather than a spinner that claims
  to know more.

## Experiments

`experiments/` holds runnable comparisons kept out of the suite because they
take minutes and some spend money. `transport-stability.mjs` and
`transport-load.mjs` measure the transports; `record-match.mjs` records a live
match headlessly; `match-report.mjs` prints a finished game. Their README says
what each one is for and what it needs.

---
name: arena-maintain
description: Change Gomoku Arena itself — the server, the page, the record, or the design. Use when editing match state, the MCP surface, the relay, the review, or the interface. Covers the invariants that hold the project together, the test suite, the visual system, and the failures already paid for. Boundary, use arena-play to play a game and arena-extend to add a player.
---

# Working on the arena

## Invariants

These are load-bearing. Each one was paid for.

**The move list is the only stored fact.** `server/match.js` writes the moves
and nothing derived from them; the board, the side to move, the winner and every
frame a review steps through are replayed. Storing a board alongside the moves
would be two copies of one fact, free to disagree after any change. It also
makes a saved file portable.

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

## The suite

`pnpm test` runs eight suites and needs no network. Server-backed suites take a
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

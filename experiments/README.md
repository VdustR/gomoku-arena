# Experiments

Runnable comparisons, kept out of the test suite because they take minutes and
some of them spend money.

## `transport-stability.ts`

End-to-end games where the decision is identical on both routes — the same Jev
call, the same candidates, the same control loop — so the only difference is
how the position is read and how the move reaches the board.

```sh
node experiments/transport-stability.ts 4
```

Needs `TYPESAFE_API_KEY`. Reads and writes are timed separately from the
decision: a game's length is noise, because two runs diverge after the first
differing move, and counting turns then measures the game rather than the
plumbing.

## `transport-load.ts`

The same two transports without a model, which buys thousands of operations in
the time a few games take. A hundred turns of zero failures cannot tell a 0%
failure rate from a 3% one; this can.

```sh
node experiments/transport-load.ts 1500 8
```

Needs no credentials. Runs at concurrency 1 and again at the level given, since
an agent holding a connection and eight of them are different questions.

## Running a table of matches

`mixed-tournament.ts` plays a written list of pairings and films each one. A
seat is either a provider id the page drives, or `agent:<label>` for a seat a
harness plays over MCP — for those it opens the match, records it and waits.

```sh
node experiments/mixed-tournament.ts fixtures.json out/cross 3
```

The fixture file is a list of `{ black, white }`. Writing the pairings down
rather than generating them is what lets an agent seat be started by hand in
batches. Results are merged into `matches.json` by match id, so two of these
running at once do not overwrite each other.

`assistance-tournament.ts` is the generated-pairing version for in-page seats
only: one model at three assistance levels plus the heuristic as a baseline,
every pairing both colours, driven and filmed by the same headless page.

```sh
node experiments/assistance-tournament.ts out/assistance 3
```

## Reading a table back

Three readers, all offline against the stored move lists. None of them calls a
model, and none takes a figure from what a player said about its own move.

```sh
node experiments/cross-analysis.ts out/cross/matches.json --out REPORT.md
node experiments/play-style.ts out/cross/matches.json --out STYLE.md
node experiments/assistance-analysis.ts out/assistance/matches.json REPORT.md
```

- `cross-analysis` — standings, the cross table named by winner and colour,
  reaction time, and how much of each in-page seat was the model rather than
  the heuristic feeding it.
- `play-style` — what each move did (attack, block, both, quiet), how often a
  standing four or open three went unanswered, and how the wins were finished.
  The miss rate is the figure that tracks the standings most closely.
- `assistance-analysis` — the same questions for one model at several
  assistance levels.

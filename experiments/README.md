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

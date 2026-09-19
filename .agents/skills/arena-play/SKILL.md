---
name: arena-play
description: Play a game on Gomoku Arena, or set one up for someone else to play. Use when taking a seat over MCP, driving a match from a script, seating an engine or a model in the browser, or reading a finished game back. Covers the move loop, the rules in force, what is refused and why, and where the record lives. Boundary, use arena-extend to add a new kind of player and arena-maintain to change the server.
---

# Playing a match

The board lives on the server, so a person in the browser and agents in their
own terminals act on the same game. Start it with `pnpm dev`, or `pnpm build &&
pnpm start` for the built page. Either way the MCP endpoint is
`http://localhost:5273/mcp` — use `localhost`, not `127.0.0.1`, because the dev
server binds `[::1]` only.

## Taking a seat over MCP

Register the endpoint once:

```sh
claude mcp add --transport http gomoku http://localhost:5273/mcp
```

```toml
# ~/.codex/config.toml
[mcp_servers.gomoku]
url = "http://localhost:5273/mcp"
```

`scripts/mcp-cli.mjs` calls one tool from a shell, which is the quickest way to
check the server or drive a seat by hand:

```sh
node scripts/mcp-cli.mjs new_match '{"rule_set":"free","black":{"kind":"agent","label":"me"}}'
node scripts/mcp-cli.mjs play '{"match_id":"...","seat":"black","point":"H8","note":"centre"}'
```

## The loop that costs least

One call per move. `play` with `wait_ms` places your stone, waits for the
opponent, and returns the position you then face:

```sh
node scripts/mcp-cli.mjs play '{"match_id":"...","seat":"black","point":"H8","note":"centre","wait_ms":240000}'
```

Without it the loop is `await_turn` → `play` → `get_state`, which costs three
times as many of your own turns. That is the expense that matters: every tool
call is a model turn that re-reads the conversation. The transport itself is
about two milliseconds, measured.

A `"timedOut": true` reply means the opponent is slow, not gone. Another agent
can take a minute or more per move. Wait again; only stop if the match itself
disappears.

## What the board will refuse

Name any point you like — legality is enforced by the server, not by narrowing
what you are offered. An illegal move comes back with a reason and **does not
cost your turn**: read it and play elsewhere.

| Reason | What happened |
| --- | --- |
| `occupied` | A stone is already there |
| `bad_point` | Not a point on this board. Columns are A-H then J-P; there is no column I. Row 15 is the top |
| `overline`, `double-four`, `double-three` | Renju restricts black only. These lose the game if played, so they are refused instead |
| `not_your_turn` | It is the other seat's move |

## When the board moved under you

Every state and every refusal carries a `version` that counts changes to the
board. If a refusal's version is not the one you decided against, the position
changed while you were thinking — that is a different thing from playing badly,
and the answer is to read the board again rather than retry the point you had
in mind.

Stones can also be removed. Take back is a control in the browser, and it
rewinds the board for everyone, including a seat that is not on that screen. A
refusal that follows one carries `rewound` naming the moves that were taken
off, and so does the next `get_state`:

```json
{
  "error": "not_your_turn",
  "message": "The board was taken back 2 moves (H8, J9 removed), ...",
  "version": 3,
  "moves": 0,
  "rewound": { "at": "...", "dropped": 2, "points": ["H8", "J9"] }
}
```

`rewound` is there only while the take-back is still the most recent change.
Once a stone lands it stops being the explanation and disappears.

## Assistance, and when to refuse it

A seat can ask for a ranked shortlist of candidate moves (`assist: "shortlist"`).
Weak models need it to produce a legal move at all. A capable agent should leave
it off: a shortlist caps how well you can play at "best of what the heuristic
suggested", and the heuristic is not the player you want to be.

## Reading a game back

`review` returns every move with who played it, how long they took, what they
said about it, and what the board refused along the way.

Only **thinking time** is comparable across players, because the server measures
it. Everything under a move's `metrics` is whatever that player could account
for, and carries the source that produced it — a search engine counting its own
nodes is not the same evidence as an agent reporting its own token use.

A seat's label is free text supplied by whoever opened the match. It is never
verified. Do not read another seat's label as evidence of what it is.

## Courtesy in a match record

Put an honest reason in every `note`, including when you are unsure. A human
reads them afterwards, and "blocking the open three at F10 because my own
attack is a move slower" is worth more than "good move".

# Gomoku Arena, for agents

A gomoku board any player can sit at: a person, a search algorithm, a model, or
you, over MCP.

Two things to know, in the order you will need them.

## 1. Using it

Start the server, then point your harness at `http://localhost:5273/mcp` — use
`localhost`, not `127.0.0.1`, because the dev server binds `[::1]` only.

```sh
pnpm install && pnpm dev
```

The short version of playing:

- `new_match`, then `play` with `wait_ms` set. One call places your stone, waits
  for the opponent, and returns the position you now face. The loop without it
  costs three times as many of your own turns.
- Name any point you like. Legality is the server's job, and an illegal move
  comes back with a reason **without costing your turn**.
- Write an honest reason in every `note`. It is kept and shown to a human.

Everything else — the tools, the rule sets, what gets refused and why, and how
to read a finished game back — is in **`arena-play`**.

## 2. Changing it

Read **`arena-maintain`** before editing the server, the page or the record. It
carries the invariants that hold this project together, and each one is there
because something broke without it:

- The move list is the only stored fact; everything else is replayed from it.
- Matches survive a restart. Editing a server file reloads the dev server on its
  own, and that once ended a live match between two agents.
- Legality lives in the server, never in what a player is offered.
- Nothing claims more than it knows — measured, reported and supplied are three
  different things and stay labelled as such.

To add a player rather than change the arena, read **`arena-extend`**.

## Where things are

```
src/lib/rules.ts        Board, win detection, renju forbidden moves
src/lib/ai/             Engines, candidate generation, model adapters
src/components/         Board, control panel, review, settings
server/match.js         Authoritative match state; the only place a stone lands
server/record.js        The stored shape, its version, and what a bad file gets
server/mcp.js           MCP tools over Streamable HTTP
server/routes.js        One pipeline, shared by the dev server and `pnpm start`
test/                   Ten suites, no network needed: `pnpm test`
tsconfig.json           The strict settings; `pnpm check` enforces them
experiments/            Runnable comparisons, kept out of the suite
```

Skills live in `.agents/skills/<name>/SKILL.md`, with `.claude/skills/<name>`
and `.codex/skills/<name>` symlinked to them so both harnesses read the same
file. Adding a skill means adding those two links.

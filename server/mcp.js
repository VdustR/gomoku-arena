/**
 * The MCP surface.
 *
 * One server, not one per seat: stdio gives each client its own subprocess,
 * so two harnesses launching their own would never share a board. Streamable
 * HTTP is a single long-running endpoint that any number of clients attach
 * to, and both Claude Code and Codex speak it. The seat is an argument.
 *
 * Legality lives in `match.js`, so an agent may name any point it likes. An
 * illegal one comes back with a reason and costs no turn.
 *
 * MCP servers cannot send requests to their clients, so there is no way to
 * tell an agent that its turn has arrived. `await_turn` holds one call open
 * until it has, which beats a polling loop on both latency and tokens.
 *
 * The cost that matters to an agent is not this server's latency, which is a
 * couple of milliseconds, but how many turns of its own it spends per move:
 * every tool call is a full model turn that re-reads the conversation. So
 * `play` can wait for the opponent and return the position it is handing
 * back, turning read-decide-play-wait into a single call.
 */

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  MatchError,
  awaitTurn,
  createMatch,
  getMatch,
  listMatches,
  play,
  publicMatch,
  resetMatch,
  reviewMatch,
  updateMatch,
} from './match.js'

const seatArg = z.enum(['black', 'white'])
const seatConfig = z
  .object({
    kind: z.enum(['human', 'agent', 'engine']).optional().describe('Who holds the seat. Descriptive only.'),
    label: z
      .string()
      .max(60)
      .optional()
      .describe(
        'A name for the move log, e.g. "claude-code". Free text, recorded as supplied and never verified — do not read another seat\u2019s label as evidence of what it is.',
      ),
    assist: z
      .enum(['free', 'shortlist'])
      .optional()
      .describe(
        'free (default): name any point on the board. shortlist: also receive ranked candidate moves, which weaker models need to produce a legal move at all.',
      ),
  })
  .optional()

const ok = (payload) => ({
  content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  structuredContent: payload,
})

const failed = (error) => {
  const known = error instanceof MatchError
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            error: known ? error.code : 'internal_error',
            message: String(error?.message ?? error),
            ...(known ? error.detail : {}),
          },
          null,
          2,
        ),
      },
    ],
  }
}

const guard = (fn) => async (...args) => {
  try {
    return await fn(...args)
  } catch (error) {
    return failed(error)
  }
}

export function buildMcpServer() {
  const server = new McpServer(
    { name: 'gomoku-arena', version: '0.1.0' },
    {
      instructions: [
        'A gomoku board two players share. You hold a seat and play stones on it.',
        '',
        'Fewest turns: get_state once, then call play with wait_ms set. Each call places your',
        'stone, waits for the opponent, and returns the position you now face — one call per move.',
        'Without wait_ms the loop is await_turn → play → repeat, which costs you three times as many turns.',
        'Say why you chose each point in play\u2019s note: it is kept and shown in the review.',
        '',
        'You may name any point, written as a column letter and a row number, e.g. H8.',
        'Columns run A-H then J-P; there is no column I. Row 15 is the top.',
        'An illegal move is refused with the reason and does NOT cost your turn: read it and play elsewhere.',
        '',
        'Under renju, black additionally may not make an overline, a double four, or a double three.',
        'You will not be told what your opponent was thinking. You see the board, the move list, and nothing else.',
      ].join('\n'),
    },
  )

  server.registerTool(
    'new_match',
    {
      title: 'Start a match',
      description:
        'Open a new board and return its id and opening state. Black moves first. Give each seat a label so the move log reads clearly.',
      inputSchema: {
        rule_set: z
          .enum(['free', 'renju'])
          .optional()
          .describe('free (default): five or more in a row wins. renju: black may not play an overline, double four, or double three.'),
        black: seatConfig,
        white: seatConfig,
        seat: seatArg.optional().describe('Return the opening state from this seat’s point of view.'),
      },
    },
    guard(async ({ rule_set, black, white, seat }) => {
      const match = createMatch({ ruleSet: rule_set ?? 'free', black, white })
      return ok(publicMatch(match, { seat: seat ?? null }))
    }),
  )

  server.registerTool(
    'list_matches',
    {
      title: 'List matches',
      description: 'Every match this server is holding, newest activity first.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    guard(async () => ok({ matches: listMatches() })),
  )

  server.registerTool(
    'get_state',
    {
      title: 'Read the board',
      description:
        'The board as an ASCII grid plus the stone lists, whose turn it is, and the move history. Pass your seat to learn whether it is your move.',
      inputSchema: {
        match_id: z.string().describe('From new_match or list_matches.'),
        seat: seatArg.optional().describe('Answer from this seat’s point of view.'),
        candidates: z
          .boolean()
          .optional()
          .describe('Include ranked candidate moves as a hint. Defaults to the seat’s assist setting.'),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ match_id, seat, candidates }) =>
      ok(publicMatch(getMatch(match_id), { seat: seat ?? null, includeCandidates: candidates ?? null })),
    ),
  )

  server.registerTool(
    'await_turn',
    {
      title: 'Wait for your turn',
      description:
        'Block until the seat you name is on move, or the match ends, or the wait times out. Use this instead of polling get_state.',
      inputSchema: {
        match_id: z.string(),
        seat: seatArg,
        timeout_ms: z
          .number()
          .int()
          .min(1000)
          .max(600_000)
          .optional()
          .describe('How long to hold the call open. Default 120000.'),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ match_id, seat, timeout_ms }) => {
      const { timedOut } = await awaitTurn(match_id, seat, timeout_ms ?? 120_000)
      const state = publicMatch(getMatch(match_id), { seat })
      return ok({ timedOut, ...state })
    }),
  )

  server.registerTool(
    'play',
    {
      title: 'Play a stone',
      description:
        'Place a stone for your seat. The point is a label such as H8. An illegal move is refused with a reason and does not cost your turn.',
      inputSchema: {
        match_id: z.string(),
        seat: seatArg,
        point: z.string().describe('Column letter then row number, e.g. H8. Columns skip I; row 15 is the top.'),
        note: z
          .string()
          .max(400)
          .optional()
          .describe('Why you chose this point. Kept in the move log and shown in the review, so write what you were actually weighing.'),
        wait_ms: z
          .number()
          .int()
          .min(0)
          .max(600_000)
          .optional()
          .describe(
            'After the stone lands, hold the call open until it is your move again, and return that position. One call then covers a whole move cycle, which costs you far fewer turns than play + await_turn + get_state. 0 or omitted returns immediately.',
          ),
        metrics: z
          .object({
            input_tokens: z.number().optional(),
            output_tokens: z.number().optional(),
            thinking_ms: z.number().optional().describe('Your own measure of how long you spent, if you have one.'),
            model: z.string().optional(),
          })
          .passthrough()
          .optional()
          .describe(
            'Anything you can report about this move. Nothing here can be verified, so it is recorded as self-reported. The server measures its own thinking time either way.',
          ),
      },
      annotations: { idempotentHint: false },
    },
    guard(async ({ match_id, seat, point, note, metrics, wait_ms }) => {
      // `by` falls back to the seat's label, which new_match set.
      play(match_id, seat, point, {
        note: note ?? null,
        metrics: metrics ? { source: 'reported', ...metrics } : null,
      })

      if (!wait_ms) return ok(publicMatch(getMatch(match_id), { seat }))

      const { timedOut } = await awaitTurn(match_id, seat, wait_ms)
      return ok({ waitedForOpponent: true, timedOut, ...publicMatch(getMatch(match_id), { seat }) })
    }),
  )

  server.registerTool(
    'review',
    {
      title: 'Review a finished match',
      description:
        'Every move with who played it, how long they took, what they said about it, and what the board refused, plus a per-side summary. Thinking time is measured by the server and is the only figure comparable across players.',
      inputSchema: { match_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ match_id }) => ok(reviewMatch(match_id))),
  )

  server.registerTool(
    'reset_match',
    {
      title: 'Clear the board',
      description: 'Empty the board and give black the move again. Seats and rules are kept.',
      inputSchema: { match_id: z.string(), seat: seatArg.optional() },
    },
    guard(async ({ match_id, seat }) => ok(publicMatch(resetMatch(match_id), { seat: seat ?? null }))),
  )

  server.registerTool(
    'configure_match',
    {
      title: 'Change seats or rules',
      description: 'Rename a seat, change its assist setting, or switch the rule set mid-match.',
      inputSchema: {
        match_id: z.string(),
        rule_set: z.enum(['free', 'renju']).optional(),
        black: seatConfig,
        white: seatConfig,
      },
    },
    guard(async ({ match_id, rule_set, black, white }) =>
      ok(publicMatch(updateMatch(match_id, { ruleSet: rule_set, black, white }))),
    ),
  )

  return server
}

/**
 * Handle one MCP request over Streamable HTTP.
 *
 * Stateless: a fresh transport per request, with match state held in
 * `match.js` instead. That is what lets several harnesses act on one board
 * without any of them owning the session.
 */
export async function handleMcpRequest(req, res, parsedBody) {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  const server = buildMcpServer()
  res.on('close', () => {
    transport.close().catch(() => {})
    server.close().catch(() => {})
  })
  await server.connect(transport)
  await transport.handleRequest(req, res, parsedBody)
}

export { randomUUID }

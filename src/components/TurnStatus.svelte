<script lang="ts">
  /**
   * Whether anything is actually happening.
   *
   * A seat played from outside this page — an agent on the MCP endpoint —
   * gives the page nothing to show, so a match between two agents looked
   * identical to a frozen one. The server does not report that an agent is
   * thinking, and cannot: it only knows whose turn it is and when the turn
   * began. That is enough to say how long a side has been on move, which is
   * the honest version of a progress indicator.
   */

  import { AGENT } from '../lib/game.svelte.ts'

  let { seat, seatName, isTurn, thinking, status, since, providerName, waiting = false } = $props()

  let now = $state(Date.now())
  $effect(() => {
    // Nothing is being thought about before the match is started, so nothing
    // should be counted. A clock running then is a fabricated measurement, and
    // it is the same readout that reports real thinking time once a game is
    // under way.
    if (!isTurn || waiting || status !== 'playing') return
    const tick = setInterval(() => (now = Date.now()), 250)
    return () => clearInterval(tick)
  })

  const elapsed = $derived(Math.max(0, Math.round((now - since) / 1000)))
  const clock = $derived(elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`)

  /**
   * What is true right now, in the words that fit who holds the seat.
   *
   * Named `readout` rather than `state`: a local `state` makes `$state`
   * ambiguous with the rune, and the checker reads it as a store
   * subscription on this variable instead.
   */
  const readout = $derived.by(() => {
    if (status !== 'playing') return { kind: 'idle', label: null }
    if (!isTurn) return { kind: 'idle', label: 'waiting' }
    if (waiting) return { kind: 'idle', label: 'ready to start' }
    if (seat.kind === 'human') return { kind: 'you', label: 'your move' }
    if (seat.kind === AGENT) return { kind: 'busy', label: `${seat.label ?? 'agent'} is on move` }
    if (thinking) return { kind: 'busy', label: `${providerName} is thinking` }
    return { kind: 'busy', label: `${providerName} is on move` }
  })
</script>

<div class="status" class:busy={readout.kind === 'busy'} class:you={readout.kind === 'you'}>
  {#if readout.kind === 'busy'}
    <span class="pulse" aria-hidden="true"></span>
  {/if}
  <span class="label">{readout.label ?? seatName}</span>
  {#if readout.kind !== 'idle'}
    <span class="clock tnum">{clock}</span>
  {/if}
</div>

<style>
  .status {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    font-size: 0.75rem;
    color: var(--text-lo);
    min-height: 1.1rem;
  }

  .status.busy .label,
  .status.you .label {
    color: var(--text-hi);
  }

  .clock {
    color: var(--text-lo);
    margin-left: auto;
  }

  .pulse {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--amber);
    flex: none;
    animation: breathe 1.4s var(--ease-out) infinite;
  }

  @keyframes breathe {
    0%,
    100% {
      opacity: 0.25;
      transform: scale(0.8);
    }
    50% {
      opacity: 1;
      transform: scale(1.2);
    }
  }
</style>

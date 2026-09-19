<script lang="ts">
  /**
   * Going back through a finished match.
   *
   * Thinking time is the one figure measured the same way for every player,
   * so it leads. Everything under a move's metrics is whatever that player
   * could account for, and says where it came from — a search engine counting
   * its own nodes is not the same kind of evidence as an agent reporting its
   * own token use, and the panel does not pretend otherwise.
   */

  import type { Review } from '../../server/match.ts'

  interface Props {
    review: Review
    at: number
    onseek: (index: number) => void
    onclose: () => void
  }

  let { review, at, onseek, onclose }: Props = $props()

  const move = $derived(at > 0 ? (review.moves[at - 1] ?? null) : null)
  const ms = (value: number | null | undefined): string =>
    value == null ? '—' : value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(1)} s`

  /** Where a figure came from, in the words the reader needs. */
  const SOURCE_COPY: Record<string, string> = {
    measured: 'measured by the engine or its endpoint',
    reported: 'self-reported, not verifiable here',
  }

  function onkeydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      onseek(at - 1)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      onseek(at + 1)
    } else if (event.key === 'Home') {
      onseek(0)
    } else if (event.key === 'End') {
      onseek(review.moves.length)
    }
  }
</script>

<svelte:window {onkeydown} />

<section class="review">
  <header>
    <h3>Review</h3>
    <button type="button" onclick={onclose}>Back to the game</button>
  </header>

  <div class="scrub">
    <button type="button" onclick={() => onseek(at - 1)} disabled={at === 0} aria-label="Previous move">
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3L5 8l5 5" /></svg>
    </button>
    <input
      type="range"
      min="0"
      max={review.moves.length}
      value={at}
      oninput={(e) => onseek(Number(e.currentTarget.value))}
      aria-label="Move number"
    />
    <button type="button" onclick={() => onseek(at + 1)} disabled={at === review.moves.length} aria-label="Next move">
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3l5 5-5 5" /></svg>
    </button>
    <span class="counter tnum">{at} / {review.moves.length}</span>
  </div>

  {#if move}
    <dl class="move">
      <div>
        <dt>Move</dt>
        <dd>
          <span class="disc" class:white={move.seat === 'white'}></span>
          <span class="tnum">{move.point}</span>
        </dd>
      </div>
      <div>
        <dt>Played by</dt>
        <dd>{move.by ?? move.seat}</dd>
      </div>
      <div>
        <dt>Thinking time</dt>
        <dd class="tnum">{ms(move.thinkingMs)}</dd>
      </div>
    </dl>

    {#if move.note}
      <p class="said">{move.note}</p>
    {/if}

    {#if move.rejected.length}
      <div class="refused">
        <h4>Refused before this move</h4>
        <ul>
          {#each move.rejected as attempt}
            <li>
              <span class="tnum">{attempt.point}</span>
              <span>{attempt.reason.replace('-', ' ')}</span>
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    {#if move.metrics}
      <div class="metrics">
        <h4>What this player could account for</h4>
        <dl>
          {#each Object.entries(move.metrics).filter(([key]) => key !== 'source') as [key, value]}
            <div>
              <dt>{key.replace(/_/g, ' ')}</dt>
              <dd class:tnum={typeof value === 'number'}>{value}</dd>
            </div>
          {/each}
        </dl>
        <p class="source">{SOURCE_COPY[move.metrics.source] ?? move.metrics.source}</p>
      </div>
    {/if}
  {:else}
    <p class="empty">The opening position. Step forward to follow the game.</p>
  {/if}

  <div class="summary">
    <h4>Whole match</h4>
    <table>
      <thead>
        <tr>
          <th scope="col"></th>
          <th scope="col">Black</th>
          <th scope="col">White</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <th scope="row">Player <span class="asserted">as supplied</span></th>
          <td>{review.sides.black.player.label ?? review.sides.black.player.kind}</td>
          <td>{review.sides.white.player.label ?? review.sides.white.player.kind}</td>
        </tr>
        <tr>
          <th scope="row">Moves</th>
          <td class="tnum">{review.sides.black.moves}</td>
          <td class="tnum">{review.sides.white.moves}</td>
        </tr>
        <tr>
          <th scope="row">Total thinking</th>
          <td class="tnum">{ms(review.sides.black.thinking.totalMs)}</td>
          <td class="tnum">{ms(review.sides.white.thinking.totalMs)}</td>
        </tr>
        <tr>
          <th scope="row">Median</th>
          <td class="tnum">{ms(review.sides.black.thinking.medianMs)}</td>
          <td class="tnum">{ms(review.sides.white.thinking.medianMs)}</td>
        </tr>
        <tr>
          <th scope="row">Slowest</th>
          <td class="tnum">{ms(review.sides.black.thinking.slowestMs)}</td>
          <td class="tnum">{ms(review.sides.white.thinking.slowestMs)}</td>
        </tr>
        <tr>
          <th scope="row">Refused</th>
          <td class="tnum">{review.sides.black.rejected}</td>
          <td class="tnum">{review.sides.white.rejected}</td>
        </tr>
        {#each [...new Set([...Object.keys(review.sides.black.metrics ?? {}), ...Object.keys(review.sides.white.metrics ?? {})])].filter((key) => key !== 'sources') as key}
          <tr>
            <th scope="row">{key.replace(/_/g, ' ')}</th>
            <td class="tnum">{review.sides.black.metrics?.[key] ?? '—'}</td>
            <td class="tnum">{review.sides.white.metrics?.[key] ?? '—'}</td>
          </tr>
        {/each}
      </tbody>
    </table>
    <p class="source">{review.note}</p>
    <a href={`/api/match/${review.id}/review`} download={`gomoku-${review.id}.json`}>Download the record</a>
  </div>
</section>

<style>
  .review {
    background: var(--ink-800);
    border-radius: var(--radius);
    padding: 1.25rem;
    box-shadow: var(--shadow-soft);
    display: grid;
    gap: 1.1rem;
    align-content: start;
  }

  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
  }

  h3 {
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-lo);
  }

  h4 {
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--text-lo);
    margin: 0 0 0.5rem;
  }

  header button {
    background: none;
    border: none;
    color: var(--amber-hi);
    font-size: 0.8125rem;
    cursor: pointer;
    padding: 0;
  }
  header button:hover {
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  .scrub {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }

  .scrub button {
    background: var(--ink-750);
    border: 1px solid var(--ink-600);
    border-radius: var(--radius-sm);
    color: var(--text);
    padding: 0.3rem 0.45rem;
    cursor: pointer;
    display: grid;
    place-items: center;
  }
  .scrub button:hover:not(:disabled) {
    border-color: var(--amber);
    color: var(--text-hi);
  }
  .scrub button:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }

  input[type='range'] {
    flex: 1;
    min-width: 0;
    accent-color: var(--amber);
  }

  .counter {
    font-size: 0.75rem;
    color: var(--text-lo);
    min-width: 3.5rem;
    text-align: right;
  }

  dl {
    margin: 0;
    display: grid;
    gap: 0.4rem;
  }

  dl > div {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    font-size: 0.8125rem;
  }

  dt {
    color: var(--text-lo);
  }

  dd {
    margin: 0;
    color: var(--text-hi);
    text-align: right;
    display: flex;
    align-items: center;
    gap: 0.45rem;
    justify-content: flex-end;
    overflow-wrap: anywhere;
  }

  .disc {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: linear-gradient(145deg, #4a4f58, #0b0c0f);
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.5);
    flex: none;
  }
  .disc.white {
    background: linear-gradient(145deg, #ffffff, #d9d2c2);
  }

  .said {
    margin: 0;
    padding: 0.65rem 0.8rem;
    border-radius: var(--radius-sm);
    background: var(--ink-850);
    font-size: 0.8125rem;
    line-height: 1.6;
    color: var(--text);
  }

  .refused ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.25rem;
  }

  .refused li {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    font-size: 0.75rem;
    color: #d9a9a9;
  }

  .metrics .source,
  .summary .source {
    margin: 0.6rem 0 0;
    font-size: 0.6875rem;
    line-height: 1.55;
    color: #6b7286;
  }

  .summary table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.75rem;
  }

  .summary th,
  .summary td {
    padding: 0.3rem 0;
    text-align: right;
    font-weight: 400;
  }

  .summary thead th {
    color: var(--text-lo);
    border-bottom: 1px solid var(--ink-700);
    padding-bottom: 0.45rem;
  }

  .summary tbody th {
    text-align: left;
    color: var(--text-lo);
  }

  /* A name on a seat is whatever the match was opened with, not a finding. */
  .asserted {
    display: block;
    font-size: 0.625rem;
    color: #5f6577;
  }

  .summary td {
    color: var(--text-hi);
  }

  .summary a {
    display: inline-block;
    margin-top: 0.7rem;
    font-size: 0.75rem;
    color: var(--teal-hi);
  }

  .empty {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--text-lo);
  }
</style>

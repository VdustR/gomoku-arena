<script>
  import { PROVIDERS } from '../lib/ai/providers.ts'

  let { telemetry, history, thinking, thinkingFor } = $props()

  const providerName = (id) => (id === 'human' ? 'You' : (PROVIDERS[id]?.name ?? id))
  const pct = (weight) => `${Math.round((weight ?? 0) * 100)}%`

  const ranked = $derived(
    (telemetry?.ranked ?? [])
      .filter((entry) => entry.weight > 0.001)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 6),
  )
</script>

<aside>
  <section class="decision">
    <h3>Last decision</h3>

    {#if thinking}
      <div class="waiting">
        <span class="dot"></span>
        <span>{thinkingFor === 1 ? 'Black' : 'White'} is choosing…</span>
      </div>
    {:else if telemetry}
      <dl class="facts">
        <div>
          <dt>Engine</dt>
          <dd>{providerName(telemetry.provider)}</dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd class="muted">{telemetry.model}</dd>
        </div>
        <div>
          <dt>Latency</dt>
          <dd class="tnum">{telemetry.latencyMs} ms</dd>
        </div>
        {#if telemetry.confidence != null}
          <div>
            <dt>Confidence</dt>
            <dd class="tnum">{telemetry.confidence.toFixed(2)}</dd>
          </div>
        {/if}
        {#if telemetry.usage?.input_tokens != null}
          <div>
            <dt>Input tokens</dt>
            <dd class="tnum">{telemetry.usage.input_tokens}</dd>
          </div>
        {/if}
        {#if telemetry.usage?.prompt_tokens != null}
          <div>
            <dt>Prompt tokens</dt>
            <dd class="tnum">{telemetry.usage.prompt_tokens}</dd>
          </div>
        {/if}
      </dl>

      {#if ranked.length}
        <div class="ranked">
          <h4>How the candidates scored</h4>
          <ul>
            {#each ranked as entry}
              <li>
                <span class="label tnum">{entry.label}</span>
                <span class="bar"><span class="fill" style="--s: {entry.weight}"></span></span>
                <span class="weight tnum">{pct(entry.weight)}</span>
              </li>
            {/each}
          </ul>
        </div>
      {/if}

      {#if telemetry.pressure}
        <p class="pressure">
          <span>Danger read</span>
          <strong>{telemetry.pressure.top}</strong>
        </p>
      {/if}

      {#if telemetry.notes}
        <p class="notes">{telemetry.notes}</p>
      {/if}
    {:else}
      <p class="empty">Nothing yet. The panel fills in once an engine takes a turn.</p>
    {/if}
  </section>

  <section class="log">
    <h3>Moves <span class="count tnum">{history.length}</span></h3>
    {#if history.length === 0}
      <p class="empty">The board is empty.</p>
    {:else}
      <ol>
        {#each history.slice().reverse() as move}
          <li>
            <span class="n tnum">{move.n}</span>
            <span class="disc" class:white={move.color === 2}></span>
            <span class="coord tnum">{move.label}</span>
            <span class="who">{providerName(move.provider)}</span>
            <span class="ms tnum">{move.latencyMs != null ? `${move.latencyMs} ms` : '—'}</span>
          </li>
        {/each}
      </ol>
    {/if}
  </section>
</aside>

<style>
  aside {
    display: grid;
    gap: 1rem;
    align-content: start;
    min-width: 0;
  }

  section {
    background: var(--ink-800);
    border-radius: var(--radius);
    padding: 1.25rem;
    box-shadow: var(--shadow-soft);
  }

  h3 {
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-lo);
    margin-bottom: 1rem;
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }

  h4 {
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--text-lo);
    margin: 0 0 0.6rem;
  }

  .count {
    color: var(--text-hi);
    font-size: 0.8125rem;
  }

  .empty {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--text-lo);
  }

  .waiting {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    font-size: 0.875rem;
    color: var(--text-hi);
  }

  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--amber);
    animation: breathe 1.2s var(--ease-out) infinite;
  }

  @keyframes breathe {
    0%,
    100% {
      opacity: 0.25;
      transform: scale(0.8);
    }
    50% {
      opacity: 1;
      transform: scale(1.15);
    }
  }

  .facts {
    display: grid;
    gap: 0.45rem;
    margin: 0 0 1.1rem;
  }

  .facts > div {
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
    overflow-wrap: anywhere;
  }

  dd.muted {
    color: var(--text);
  }

  .ranked ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.4rem;
  }

  .ranked li {
    display: grid;
    grid-template-columns: 2.75rem 1fr 2.75rem;
    align-items: center;
    gap: 0.6rem;
    font-size: 0.75rem;
  }

  .label {
    color: var(--text-hi);
  }

  .bar {
    height: 6px;
    border-radius: 99px;
    background: var(--ink-700);
    overflow: hidden;
  }

  .fill {
    display: block;
    height: 100%;
    width: 100%;
    border-radius: 99px;
    background: var(--teal);
    /* Scale rather than width: the bar animates on the compositor. */
    transform: scaleX(var(--s));
    transform-origin: left center;
    transition: transform 420ms var(--ease-out);
  }

  .weight {
    color: var(--text-lo);
    text-align: right;
  }

  .pressure {
    margin: 1.1rem 0 0;
    display: grid;
    gap: 0.2rem;
    font-size: 0.8125rem;
  }
  .pressure span {
    color: var(--text-lo);
  }
  .pressure strong {
    color: var(--amber-hi);
    font-weight: 500;
  }

  .notes {
    margin: 0.9rem 0 0;
    font-size: 0.75rem;
    color: var(--text-lo);
    line-height: 1.55;
  }

  .log ol {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.3rem;
    max-height: 17rem;
    overflow-y: auto;
  }

  .log li {
    display: grid;
    grid-template-columns: 1.6rem 0.75rem 2.6rem 1fr auto;
    align-items: center;
    gap: 0.55rem;
    font-size: 0.75rem;
    padding: 0.2rem 0;
  }

  .n {
    color: #5f6577;
  }

  .disc {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: linear-gradient(145deg, #4a4f58, #0b0c0f);
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.5);
  }
  .disc.white {
    background: linear-gradient(145deg, #ffffff, #d9d2c2);
  }

  .coord {
    color: var(--text-hi);
  }

  .who {
    color: var(--text-lo);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ms {
    color: #5f6577;
  }
</style>

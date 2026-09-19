<script>
  /**
   * The controls, grouped by what they do to the game in front of you.
   *
   * They used to sit in one list, so nothing said which of them described the
   * match, which changed it, and which threw it away — picking "AI vs AI" to
   * seat an engine quietly started a new game and discarded the choice. Each
   * block now covers one consequence and says so next to the control.
   *
   * The first block is read-only on purpose: with a seat played from outside
   * this page there was nothing to look at while an agent thought, and a
   * match between two of them was indistinguishable from a frozen one.
   */

  import TurnStatus from './TurnStatus.svelte'
  import { RULE_SETS } from '../lib/rules.js'
  import { PROVIDERS } from '../lib/ai/providers.js'
  import { AGENT, BLACK, WHITE } from '../lib/game.svelte.js'

  let {
    game,
    seatOptions,
    activePreset,
    describeSeat,
    onseatchange,
    onpreset,
    onruleset,
    onclear,
  } = $props()

  const SEATS = [
    [BLACK, 'Black', 'black'],
    [WHITE, 'White', 'white'],
  ]

  const seatValue = (seat) => (seat.kind === 'engine' ? seat.provider : seat.kind)
  const outcome = $derived(
    game.status === 'win'
      ? `${game.winner === BLACK ? 'Black' : 'White'} won`
      : game.status === 'draw'
        ? 'Drawn — the board is full'
        : null,
  )
</script>

<section class="panel">
  <h3>This match</h3>

  <div class="players">
    {#each SEATS as [color, name, key]}
      <div class="player">
        <span class="who">
          <span class="disc" class:white={color === WHITE}></span>
          <span class="name">{describeSeat(color)}</span>
        </span>
        <TurnStatus
          seat={game.seats[key]}
          seatName={name}
          isTurn={game.turn === color}
          thinking={game.thinking && game.thinkingFor === color}
          status={game.status}
          since={game.turnSince}
          providerName={PROVIDERS[game.seats[key].provider]?.name ?? 'engine'}
        />
      </div>
    {/each}
  </div>

  <p class="facts">
    {#if outcome}
      <strong>{outcome}</strong>
    {:else}
      {RULE_SETS[game.ruleSet].name}
    {/if}
    <span class="sep">·</span>
    <span class="tnum">{game.history.length}</span> moves
    {#if !game.connected}
      <span class="sep">·</span><span class="offline">reconnecting</span>
    {/if}
  </p>
</section>

<section class="panel">
  <h3>Change a seat</h3>
  {#each SEATS as [color, name, key]}
    <label class="row">
      <span class="label">
        <span class="disc" class:white={color === WHITE}></span>
        {name}
      </span>
      <select value={seatValue(game.seats[key])} onchange={(e) => onseatchange(color, e.currentTarget.value)}>
        {#each seatOptions as group}
          <optgroup label={group.label}>
            {#each group.options as option}
              <option value={option.id}>{option.name}{option.note ? ` — ${option.note}` : ''}</option>
            {/each}
          </optgroup>
        {/each}
      </select>
    </label>
  {/each}
  <p class="consequence">
    Takes effect from the next move. The stones already played stay where they are.
    {#if game.seats.black.kind === AGENT || game.seats.white.kind === AGENT}
      A seat set to an agent moves from its own harness, not from here.
    {/if}
  </p>
</section>

<section class="panel">
  <h3>Start over</h3>

  <button class="wide" onclick={onclear} disabled={game.history.length === 0}>
    Clear the board
    <span class="aside">keeps both seats</span>
  </button>

  <div class="divider"></div>

  <div class="segmented" role="group" aria-label="New game">
    {#each [['pvp', 'You vs you'], ['pvc', 'You vs AI'], ['cvc', 'AI vs AI']] as [id, label]}
      <button class:active={activePreset === id} onclick={() => onpreset(id)}>{label}</button>
    {/each}
  </div>
  <p class="consequence">A new game, with both seats set to match. Replaces what is on the board.</p>

  <div class="segmented" role="group" aria-label="Rules">
    {#each Object.values(RULE_SETS) as rule}
      <button class:active={game.ruleSet === rule.id} onclick={() => onruleset(rule.id)}>{rule.name}</button>
    {/each}
  </div>
  <p class="consequence">{RULE_SETS[game.ruleSet].blurb}</p>
</section>

<style>
  .panel {
    background: var(--ink-800);
    border-radius: var(--radius);
    padding: 1.25rem;
    box-shadow: var(--shadow-soft);
    display: grid;
    gap: 0.9rem;
  }

  h3 {
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-lo);
  }

  .players {
    display: grid;
    gap: 0.85rem;
  }

  .player {
    display: grid;
    gap: 0.25rem;
  }

  .who {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    font-size: 0.875rem;
  }

  .name {
    color: var(--text-hi);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .disc {
    width: 11px;
    height: 11px;
    border-radius: 50%;
    background: linear-gradient(145deg, #4a4f58, #0b0c0f);
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.55);
    flex: none;
  }
  .disc.white {
    background: linear-gradient(145deg, #ffffff, #d9d2c2);
  }

  .facts {
    margin: 0;
    padding-top: 0.85rem;
    border-top: 1px solid var(--ink-700);
    font-size: 0.75rem;
    color: var(--text-lo);
  }

  .facts strong {
    color: var(--amber-hi);
    font-weight: 600;
  }

  .sep {
    margin: 0 0.4rem;
    color: var(--ink-500);
  }

  .offline {
    color: var(--rose);
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    font-size: 0.8125rem;
    cursor: pointer;
  }

  .row .label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--text);
  }

  select {
    background: var(--ink-850);
    border: 1px solid var(--ink-600);
    border-radius: var(--radius-sm);
    padding: 0.35rem 0.5rem;
    font-size: 0.8125rem;
    max-width: 13.5rem;
    cursor: pointer;
  }
  select:hover {
    border-color: var(--ink-500);
  }

  .consequence {
    margin: -0.2rem 0 0;
    font-size: 0.75rem;
    line-height: 1.55;
    color: var(--text-lo);
  }

  .wide {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    width: 100%;
    background: var(--ink-750);
    border: 1px solid var(--ink-600);
    border-radius: var(--radius-sm);
    padding: 0.6rem 0.85rem;
    font-size: 0.875rem;
    color: var(--text);
    cursor: pointer;
    transition:
      border-color 160ms var(--ease-out),
      color 160ms var(--ease-out);
  }
  .wide:hover:not(:disabled) {
    border-color: var(--amber);
    color: var(--text-hi);
  }
  .wide:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .aside {
    font-size: 0.75rem;
    color: var(--text-lo);
  }

  .divider {
    height: 1px;
    background: var(--ink-700);
  }

  .segmented {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: 1fr;
    gap: 3px;
    padding: 3px;
    background: var(--ink-850);
    border-radius: 10px;
  }

  .segmented button {
    background: none;
    border: none;
    border-radius: 7px;
    padding: 0.45rem 0.4rem;
    font-size: 0.8125rem;
    color: var(--text-lo);
    cursor: pointer;
    transition:
      background 180ms var(--ease-out),
      color 180ms var(--ease-out);
  }
  .segmented button:hover {
    color: var(--text-hi);
  }
  .segmented button.active {
    background: var(--ink-700);
    color: var(--text-hi);
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.4);
  }
</style>

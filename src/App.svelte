<script>
  import Board from './components/Board.svelte'
  import Telemetry from './components/Telemetry.svelte'
  import SettingsDialog from './components/Settings.svelte'
  import {
    game,
    playHuman,
    playProvider,
    resetGame,
    undoLastPair,
    stopThinking,
    forbiddenCopyFor,
    seatsForPreset,
    BLACK,
    WHITE,
  } from './lib/game.svelte.js'
  import { RULE_SETS } from './lib/rules.js'
  import { PROVIDERS, BROWSER_ID, JEV_ID, OPENAI_ID, LOCAL_ID, detectBrowserModel } from './lib/ai/providers.js'
  import { settings } from './lib/settings.svelte.js'
  import { config } from './lib/config.js'

  let settingsOpen = $state(false)
  let browserModel = $state(null)
  let rejection = $state(null)

  // The on-device model outranks everything else when it is there: no key,
  // no network, no cost. Only when it is missing does a remote engine seat.
  $effect(() => {
    detectBrowserModel().then((result) => {
      browserModel = result
      const preferred = result.supported && config.preferBrowserModel ? BROWSER_ID : settings.jevKey ? JEV_ID : LOCAL_ID
      for (const color of [BLACK, WHITE]) {
        if (game.seats[color].kind === 'ai') game.seats[color] = { kind: 'ai', provider: preferred }
      }
    })
  })

  const availableProviders = $derived(
    Object.values(PROVIDERS).filter((p) => p.id !== BROWSER_ID || browserModel?.supported),
  )

  const bothSeatsAi = $derived(game.seats[BLACK].kind === 'ai' && game.seats[WHITE].kind === 'ai')

  // Hand the turn to whichever engine is seated, once the board settles. Two
  // engines only keep going while autoplay is on, so a match can be paused.
  $effect(() => {
    if (game.status !== 'playing' || game.thinking) return
    if (game.seats[game.turn].kind !== 'ai') return
    if (bothSeatsAi && !game.autoplay) return
    const timer = setTimeout(() => playProvider(), config.moveDelayMs)
    return () => clearTimeout(timer)
  })

  const matchup = $derived(
    `${game.seats[BLACK].kind === 'human' ? 'You' : PROVIDERS[game.seats[BLACK].provider].name} vs ${
      game.seats[WHITE].kind === 'human' ? 'You' : PROVIDERS[game.seats[WHITE].provider].name
    }`,
  )

  function onplay(x, y) {
    const reason = playHuman(x, y)
    if (!reason || reason === 'not-your-turn' || reason === 'occupied') {
      rejection = null
      return
    }
    rejection = forbiddenCopyFor(reason)
    setTimeout(() => (rejection = null), 3200)
  }

  function preferredEngine() {
    if (browserModel?.supported && config.preferBrowserModel) return BROWSER_ID
    return settings.jevKey ? JEV_ID : LOCAL_ID
  }

  function setPreset(preset) {
    resetGame()
    game.seats = seatsForPreset(preset, preferredEngine())
    game.autoplay = preset === 'cvc'
  }

  const activePreset = $derived(
    game.seats[BLACK].kind === 'human' && game.seats[WHITE].kind === 'human'
      ? 'pvp'
      : game.seats[BLACK].kind === 'ai' && game.seats[WHITE].kind === 'ai'
        ? 'cvc'
        : 'pvc',
  )

  const outcome = $derived(
    game.status === 'win'
      ? `${game.winner === BLACK ? 'Black' : 'White'} wins`
      : game.status === 'draw'
        ? 'Draw — the board is full'
        : null,
  )
</script>

<div class="page">
  <header class="masthead">
    <div class="brand">
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
        <g stroke="currentColor" stroke-width="1.1" opacity="0.5">
          <path d="M4 6h16M4 12h16M4 18h16M6 4v16M12 4v16M18 4v16" />
        </g>
        <circle cx="12" cy="12" r="3.4" fill="currentColor" />
      </svg>
      <span>Gomoku Arena</span>
    </div>
    <nav>
      <a href="#how">How it works</a>
      <button class="settings" onclick={() => (settingsOpen = true)}>
        <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="8" cy="8" r="2.2" />
          <path d="M8 1.5v1.6M8 12.9v1.6M14.5 8h-1.6M3.1 8H1.5M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1M12.6 12.6l-1.1-1.1M4.5 4.5L3.4 3.4" />
        </svg>
        Settings
      </button>
    </nav>
  </header>

  <section class="intro">
    <h1>Five in a row, decided by whichever model you seat.</h1>
    <p>
      The board is the constant. Everything else swaps out: play it yourself, hand a side to Chrome’s on-device
      model, or sit two engines opposite each other and watch the reasoning arrive move by move.
    </p>
  </section>

  <main>
    <div class="board-column">
      <div class="statusbar">
        <div class="turn">
          <span class="disc" class:white={game.turn === WHITE}></span>
          {#if outcome}
            <strong class="outcome">{outcome}</strong>
          {:else}
            <span>{game.turn === BLACK ? 'Black' : 'White'} to play</span>
          {/if}
        </div>
        <span class="matchup">{matchup}</span>
      </div>

      <Board
        board={game.board}
        turn={game.turn}
        ruleSet={game.ruleSet}
        lastMove={game.lastMove}
        winningStones={game.winningStones}
        candidates={game.candidates}
        thinking={game.thinking}
        interactive={game.status === 'playing' && !game.thinking && game.seats[game.turn].kind === 'human'}
        {onplay}
      />

      {#if rejection}
        <p class="alert rejection">
          <strong>{rejection.label}.</strong>
          {rejection.detail} Renju forbids it for black — pick another point.
        </p>
      {/if}

      {#if game.error}
        <p class="alert error">
          <strong>{game.error.title}.</strong>
          {game.error.detail}
          <button onclick={() => (settingsOpen = true)}>Open settings</button>
        </p>
      {/if}
    </div>

    <div class="controls">
      <section class="panel">
        <h3>Match</h3>
        <div class="segmented" role="group" aria-label="Match type">
          {#each [['pvp', 'You vs you'], ['pvc', 'You vs AI'], ['cvc', 'AI vs AI']] as [id, label]}
            <button class:active={activePreset === id} onclick={() => setPreset(id)}>{label}</button>
          {/each}
        </div>

        <div class="seats">
          {#each [[BLACK, 'Black'], [WHITE, 'White']] as [color, name]}
            <div class="seat">
              <span class="seat-name">
                <span class="disc" class:white={color === WHITE}></span>
                {name}
              </span>
              {#if game.seats[color].kind === 'ai'}
                <select
                  value={game.seats[color].provider}
                  onchange={(e) => (game.seats[color] = { kind: 'ai', provider: e.currentTarget.value })}
                >
                  {#each availableProviders as provider}
                    <option value={provider.id}>{provider.name}</option>
                  {/each}
                </select>
              {:else}
                <span class="human">Human</span>
              {/if}
            </div>
          {/each}
        </div>
      </section>

      <section class="panel">
        <h3>Rules</h3>
        <div class="segmented" role="group" aria-label="Rule set">
          {#each Object.values(RULE_SETS) as rule}
            <button class:active={game.ruleSet === rule.id} onclick={() => (game.ruleSet = rule.id)}>
              {rule.name}
            </button>
          {/each}
        </div>
        <p class="rule-blurb">{RULE_SETS[game.ruleSet].blurb}</p>
      </section>

      <div class="actions">
        {#if game.thinking}
          <button class="secondary" onclick={stopThinking}>Stop</button>
        {:else if activePreset === 'cvc' && game.status === 'playing'}
          <button class="secondary" onclick={() => (game.autoplay = !game.autoplay)}>
            {game.autoplay ? 'Pause' : 'Continue'}
          </button>
        {:else}
          <button class="secondary" onclick={undoLastPair} disabled={game.history.length === 0}>Undo</button>
        {/if}
        <button class="primary" onclick={() => resetGame()}>New game</button>
      </div>

      <Telemetry
        telemetry={game.lastTelemetry}
        history={game.history}
        thinking={game.thinking}
        thinkingFor={game.thinkingFor}
      />
    </div>
  </main>

  <section id="how" class="how">
    <h2>Three ways to seat an engine</h2>
    <div class="providers">
      {#each [PROVIDERS[BROWSER_ID], PROVIDERS[JEV_ID], PROVIDERS[OPENAI_ID]] as provider}
        <article class:unavailable={provider.id === BROWSER_ID && browserModel && !browserModel.supported}>
          <h3>{provider.name}</h3>
          <p>{provider.tagline}</p>
          {#if provider.id === BROWSER_ID}
            <p class="status">{browserModel?.detail ?? 'Checking this browser…'}</p>
          {:else if provider.id === JEV_ID}
            <p class="status">
              Point it at TypeSafe, or at your own server — localjev and openjev speak the same wire API.
            </p>
          {:else}
            <p class="status">Bring a key from {provider.keyHint}. It stays in this browser.</p>
          {/if}
          {#if provider.docs}
            <a href={provider.docs} target="_blank" rel="noreferrer noopener">Documentation</a>
          {/if}
        </article>
      {/each}
    </div>
    <p class="method">
      No engine is asked to invent a coordinate. The page scores the position, hands over a shortlist of legal
      moves with a plain description of what each one does, and the model picks one. An illegal move cannot reach
      the board, whatever the engine replies. The board and the rules run in the page; only the two remote
      providers touch the relay, because they refuse a browser origin outright.
    </p>
  </section>

  <footer class="colophon">
    <span>MIT licensed. Runs on your machine, from a server you start.</span>
    <span>Keys live in localStorage and are sent only with the move they pay for.</span>
  </footer>
</div>

<SettingsDialog bind:open={settingsOpen} {browserModel} />

<style>
  .page {
    max-width: 76rem;
    margin: 0 auto;
    padding: 1.5rem 1rem 4rem;
    display: grid;
    gap: 2.5rem;
  }

  .masthead {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    color: var(--text-hi);
    font-weight: 600;
    font-size: 0.9375rem;
    letter-spacing: -0.01em;
  }

  .brand svg {
    color: var(--amber);
  }

  nav {
    display: flex;
    align-items: center;
    gap: 1.25rem;
    font-size: 0.875rem;
  }

  .settings {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    background: var(--ink-750);
    border: 1px solid var(--ink-600);
    border-radius: 99px;
    padding: 0.4rem 0.9rem;
    color: var(--text);
    cursor: pointer;
    transition:
      border-color 160ms var(--ease-out),
      color 160ms var(--ease-out);
  }
  .settings:hover {
    border-color: var(--amber);
    color: var(--text-hi);
  }

  .intro {
    max-width: 54ch;
    display: grid;
    gap: 0.75rem;
  }

  h1 {
    font-family: var(--font-display);
    font-size: clamp(2rem, 4.4vw, 3rem);
    line-height: 1.08;
    letter-spacing: -0.02em;
  }

  .intro p {
    margin: 0;
    color: var(--text-lo);
    line-height: 1.7;
  }

  main {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 22rem;
    gap: 1.75rem;
    align-items: start;
  }

  .board-column {
    display: grid;
    gap: 0.9rem;
    min-width: 0;
  }

  .statusbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    font-size: 0.875rem;
  }

  .turn {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    color: var(--text-hi);
  }

  .outcome {
    color: var(--amber-hi);
    font-weight: 600;
  }

  .matchup {
    color: var(--text-lo);
    font-size: 0.8125rem;
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

  .alert {
    margin: 0;
    padding: 0.7rem 0.9rem;
    border-radius: var(--radius-sm);
    font-size: 0.8125rem;
    line-height: 1.6;
  }

  .rejection {
    background: color-mix(in srgb, var(--rose) 14%, var(--ink-800));
    color: #edc9c9;
  }

  .error {
    background: color-mix(in srgb, var(--amber) 12%, var(--ink-800));
    color: #eddcc2;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }

  .error button {
    background: none;
    border: none;
    color: var(--amber-hi);
    text-decoration: underline;
    text-underline-offset: 3px;
    cursor: pointer;
    padding: 0;
    font-size: inherit;
  }

  .controls {
    display: grid;
    gap: 1rem;
    min-width: 0;
  }

  .panel {
    background: var(--ink-800);
    border-radius: var(--radius);
    padding: 1.25rem;
    box-shadow: var(--shadow-soft);
    display: grid;
    gap: 0.9rem;
  }

  .panel h3 {
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-lo);
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

  .seats {
    display: grid;
    gap: 0.5rem;
  }

  .seat {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    font-size: 0.8125rem;
  }

  .seat-name {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--text);
  }

  .human {
    color: var(--text-lo);
  }

  select {
    background: var(--ink-850);
    border: 1px solid var(--ink-600);
    border-radius: var(--radius-sm);
    padding: 0.35rem 0.5rem;
    font-size: 0.8125rem;
    max-width: 12rem;
    cursor: pointer;
  }
  select:hover {
    border-color: var(--ink-500);
  }

  .rule-blurb {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--text-lo);
    line-height: 1.6;
  }

  .actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.6rem;
  }

  .actions button {
    border-radius: var(--radius-sm);
    padding: 0.65rem 1rem;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    transition:
      background 160ms var(--ease-out),
      color 160ms var(--ease-out),
      border-color 160ms var(--ease-out);
  }

  .secondary {
    background: var(--ink-750);
    border: 1px solid var(--ink-600);
    color: var(--text);
  }
  .secondary:hover:not(:disabled) {
    border-color: var(--ink-500);
    color: var(--text-hi);
  }
  .secondary:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .primary {
    background: var(--amber);
    border: 1px solid var(--amber);
    color: var(--ink-900);
    font-weight: 600;
  }
  .primary:hover {
    background: var(--amber-hi);
    border-color: var(--amber-hi);
  }

  .how {
    display: grid;
    gap: 1.25rem;
    padding-top: 2.5rem;
    border-top: 1px solid var(--ink-700);
  }

  .how h2 {
    font-family: var(--font-display);
    font-size: clamp(1.5rem, 2.6vw, 2rem);
    letter-spacing: -0.015em;
  }

  .providers {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
    gap: 1.75rem;
  }

  .providers article {
    display: grid;
    gap: 0.4rem;
    align-content: start;
    padding-left: 1rem;
    border-left: 1px solid var(--ink-600);
  }

  .providers article.unavailable {
    opacity: 0.55;
  }

  .providers h3 {
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--text-hi);
  }

  .providers p {
    margin: 0;
    font-size: 0.8125rem;
    line-height: 1.6;
    color: var(--text);
  }

  .providers .status {
    color: var(--text-lo);
  }

  .providers a {
    font-size: 0.8125rem;
    color: var(--teal-hi);
    justify-self: start;
    margin-top: 0.2rem;
  }

  .method {
    margin: 0;
    max-width: 68ch;
    font-size: 0.875rem;
    line-height: 1.75;
    color: var(--text-lo);
  }

  .colophon {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 1.5rem;
    justify-content: space-between;
    padding-top: 1.5rem;
    border-top: 1px solid var(--ink-700);
    font-size: 0.75rem;
    color: #5f6577;
  }

  @media (max-width: 62rem) {
    main {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  @media (max-width: 40rem) {
    .page {
      padding: 1.25rem 1rem 3rem;
      gap: 2rem;
    }
    .masthead nav a {
      display: none;
    }
    .statusbar {
      flex-direction: column;
      align-items: flex-start;
      gap: 0.35rem;
    }
  }
</style>

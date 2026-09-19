<script>
  import Board from './components/Board.svelte'
  import Telemetry from './components/Telemetry.svelte'
  import SettingsDialog from './components/Settings.svelte'
  import Review from './components/Review.svelte'
  import MatchPanel from './components/MatchPanel.svelte'
  import {
    game,
    playHuman,
    playProvider,
    resetGame,
    startMatch,
    joinMatch,
    setSeat,
    setRuleSet,
    undoLastPair,
    stopThinking,
    forbiddenCopyFor,
    loadReview,
    closeReview,
    seekReview,
    reviewBoard,
    AGENT,
    BLACK,
    WHITE,
  } from './lib/game.svelte.js'
  import { RULE_SETS } from './lib/rules.js'
  import {
    PROVIDERS,
    PROVIDER_GROUPS,
    BROWSER_ID,
    JEV_ID,
    OPENAI_ID,
    DEFAULT_ENGINE_ID,
    detectBrowserModel,
  } from './lib/ai/providers.js'
  import { settings } from './lib/settings.svelte.js'
  import { config } from './lib/config.js'

  let settingsOpen = $state(false)
  let browserModel = $state(null)
  let rejection = $state(null)

  // Open a match on the server, or rejoin one named in the URL so a tab can
  // watch a game an agent started: #match=<id>
  $effect(() => {
    const fromUrl = new URLSearchParams(location.hash.slice(1)).get('match')
    const opening = fromUrl ? joinMatch(fromUrl).catch(() => startMatch()) : startMatch()
    opening
      .then((view) => {
        location.hash = `match=${view.id}`
        return detectBrowserModel()
      })
      .then((result) => {
        browserModel = result
        const preferred =
          result.supported && config.preferBrowserModel ? BROWSER_ID : settings.jevKey ? JEV_ID : DEFAULT_ENGINE_ID
        for (const color of [BLACK, WHITE]) {
          const seat = game.seats[color === BLACK ? 'black' : 'white']
          if (seat.kind === 'engine') setSeat(color, { kind: 'engine', provider: preferred })
        }
      })
      .catch((error) => {
        game.error = { title: 'Could not reach the server', detail: String(error?.message ?? error) }
      })
  })

  const availableProviders = $derived(
    Object.values(PROVIDERS).filter((p) => p.id !== BROWSER_ID || browserModel?.supported),
  )

  /** The seat picker, grouped by what the choice actually costs the player. */
  const seatOptions = $derived([
    {
      ...PROVIDER_GROUPS.seat,
      options: [
        { id: 'human', name: 'You', note: 'click the board' },
        { id: AGENT, name: 'Agent over MCP', note: 'plays from a harness' },
      ],
    },
    ...['search', 'model'].map((group) => ({
      ...PROVIDER_GROUPS[group],
      options: availableProviders.filter((p) => p.group === group),
    })),
  ].filter((group) => group.options.length > 0))

  const seatFor = (color) => game.seats[color === BLACK ? 'black' : 'white']
  const bothSeatsAi = $derived(seatFor(BLACK).kind === 'engine' && seatFor(WHITE).kind === 'engine')

  // Drive whichever in-page engine is seated, once the board settles. A seat
  // held by an agent is left alone: it moves over MCP, not from here. Two
  // engines only keep going while autoplay is on, so a match can be paused.
  $effect(() => {
    if (!game.matchId || game.status !== 'playing' || game.thinking) return
    if (seatFor(game.turn).kind !== 'engine') return
    if (bothSeatsAi && !game.autoplay) return
    const timer = setTimeout(() => playProvider(), config.moveDelayMs)
    return () => clearTimeout(timer)
  })

  const describeSeat = (color) => {
    const seat = seatFor(color)
    if (seat.kind === 'human') return 'You'
    if (seat.kind === AGENT) return seat.label ?? 'Agent over MCP'
    return PROVIDERS[seat.provider]?.name ?? seat.provider
  }
  const matchup = $derived(`${describeSeat(BLACK)} vs ${describeSeat(WHITE)}`)

  async function onplay(x, y) {
    const reason = await playHuman(x, y)
    if (!reason || reason === 'not-your-turn' || reason === 'occupied') {
      rejection = null
      return
    }
    rejection = forbiddenCopyFor(reason)
    setTimeout(() => (rejection = null), 3200)
  }

  function preferredEngine() {
    if (browserModel?.supported && config.preferBrowserModel) return BROWSER_ID
    return settings.jevKey ? JEV_ID : DEFAULT_ENGINE_ID
  }

  function onSeatChange(color, value) {
    if (value === 'human' || value === AGENT) {
      return setSeat(color, { kind: value, label: value === AGENT ? 'Agent over MCP' : null })
    }
    // Carry the engine's name onto the seat so a review reads "Minimax
    // (alpha-beta)" rather than "engine".
    return setSeat(color, { kind: 'engine', provider: value, label: PROVIDERS[value]?.name ?? value })
  }

  async function setPreset(preset) {
    const view = await startMatch({ preset })
    location.hash = `match=${view.id}`
    const engine = preferredEngine()
    for (const color of [BLACK, WHITE]) {
      if (seatFor(color).kind === 'engine') {
        await setSeat(color, { kind: 'engine', provider: engine, label: PROVIDERS[engine]?.name ?? engine })
      }
    }
  }

  const activePreset = $derived(
    seatFor(BLACK).kind === 'human' && seatFor(WHITE).kind === 'human'
      ? 'pvp'
      : bothSeatsAi
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
        board={game.review ? reviewBoard() : game.board}
        turn={game.turn}
        ruleSet={game.ruleSet}
        lastMove={game.review ? null : game.lastMove}
        winningStones={game.review && game.reviewAt < game.review.moves.length ? [] : game.winningStones}
        candidates={game.candidates}
        thinking={game.thinking}
        interactive={!game.review && game.status === 'playing' && !game.thinking && seatFor(game.turn).kind === 'human'}
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
      <MatchPanel
        {game}
        {seatOptions}
        {activePreset}
        {describeSeat}
        onseatchange={onSeatChange}
        onpreset={setPreset}
        onruleset={setRuleSet}
        onclear={resetGame}
      />

      <div class="actions">
        <button class="secondary" onclick={undoLastPair} disabled={game.history.length === 0 || game.thinking}>
          Take back
        </button>
        {#if game.thinking}
          <button class="primary" onclick={stopThinking}>Stop thinking</button>
        {:else if bothSeatsAi && game.status === 'playing'}
          <button class="primary" onclick={() => (game.autoplay = !game.autoplay)}>
            {game.autoplay ? 'Pause' : 'Play on'}
          </button>
        {:else}
          <button class="primary" onclick={loadReview} disabled={game.history.length === 0}>Review</button>
        {/if}
      </div>


      {#if game.review}
        <Review
          review={game.review}
          at={game.reviewAt}
          onseek={seekReview}
          onclose={closeReview}
        />
      {:else}
      {#if game.seats.black.kind === AGENT || game.seats.white.kind === AGENT}
        <section class="panel mcp">
          <h3>Agent seat</h3>
          <p>Point a harness at the MCP endpoint and give it this match id.</p>
          <code class="tnum">{game.matchId ?? '—'}</code>
          <p class="endpoint">
            <span class="tnum">{typeof location !== 'undefined' ? `${location.origin}/mcp` : '/mcp'}</span>
          </p>
        </section>
      {/if}

      <Telemetry
        telemetry={game.lastTelemetry}
        history={game.history}
        thinking={game.thinking}
        thinkingFor={game.thinkingFor}
      />
      {/if}
    </div>
  </main>

  <section id="how" class="how">
    <h2>What can take a seat</h2>
    <div class="providers">
      {#each [PROVIDERS.greedy, PROVIDERS.minimax, PROVIDERS.mcts, PROVIDERS[BROWSER_ID], PROVIDERS[JEV_ID], PROVIDERS[OPENAI_ID]] as provider}
        <article class:unavailable={provider.id === BROWSER_ID && browserModel && !browserModel.supported}>
          <h3>{provider.name}</h3>
          <p>{provider.tagline}</p>
          {#if provider.isEngine}
            <p class="status">Code only. No key, no network, no cost.</p>
          {:else if provider.id === BROWSER_ID}
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







  .mcp p {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--text-lo);
    line-height: 1.6;
  }

  .mcp code {
    display: block;
    font-size: 0.75rem;
    color: var(--teal-hi);
    background: var(--ink-850);
    border-radius: var(--radius-sm);
    padding: 0.5rem 0.65rem;
    overflow-wrap: anywhere;
  }

  .mcp .endpoint span {
    font-size: 0.75rem;
    color: var(--text);
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

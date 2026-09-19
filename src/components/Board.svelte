<script>
  import { SIZE, BLACK, WHITE, EMPTY, idx, coordLabel } from '../lib/rules.ts'
  import { moveLegality } from '../lib/rules.ts'

  let {
    board,
    turn,
    ruleSet,
    lastMove,
    winningStones = [],
    candidates = [],
    thinking = false,
    interactive = false,
    onplay,
    /** Shown over the board when the next move is this page's to drive. */
    awaitingStart = false,
    startLabel = 'Start',
    onstart,
    startCaption = '',
  } = $props()

  // Geometry in board units; the SVG scales to whatever the layout gives it.
  const PAD = 1.4
  const SPAN = SIZE - 1 + PAD * 2
  const STAR = [
    [3, 3],
    [11, 3],
    [3, 11],
    [11, 11],
    [7, 7],
  ]
  const COLS = 'ABCDEFGHJKLMNOPQRSTUVWXYZ'

  let hover = $state(null)

  const winSet = $derived(new Set(winningStones.map(([x, y]) => `${x},${y}`)))
  const candidateSet = $derived(new Map(candidates.map((c, i) => [`${c.x},${c.y}`, i])))

  const stones = $derived.by(() => {
    const placed = []
    for (let i = 0; i < SIZE * SIZE; i += 1) {
      const cell = board[i]
      if (cell === EMPTY) continue
      const x = i % SIZE
      const y = Math.floor(i / SIZE)
      placed.push({
        key: `${x},${y}`,
        x,
        y,
        color: cell,
        winner: winSet.has(`${x},${y}`),
        fresh: Boolean(lastMove && lastMove.x === x && lastMove.y === y),
      })
    }
    return placed
  })

  const hoverLegality = $derived(
    hover && interactive ? moveLegality(board, hover.x, hover.y, turn, ruleSet) : null,
  )

  function cellFromEvent(event) {
    const rect = event.currentTarget.getBoundingClientRect()
    const unit = rect.width / SPAN
    const x = Math.round((event.clientX - rect.left) / unit - PAD)
    const y = Math.round((event.clientY - rect.top) / unit - PAD)
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return null
    return { x, y }
  }

  function onmove(event) {
    hover = interactive ? cellFromEvent(event) : null
  }

  function onclick(event) {
    if (!interactive) return
    const cell = cellFromEvent(event)
    if (cell) onplay?.(cell.x, cell.y)
  }

  function onkeydown(event) {
    if (!interactive) return
    const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key]
    if (step) {
      event.preventDefault()
      const from = hover ?? { x: 7, y: 7 }
      hover = {
        x: Math.min(SIZE - 1, Math.max(0, from.x + step[0])),
        y: Math.min(SIZE - 1, Math.max(0, from.y + step[1])),
      }
      return
    }
    if ((event.key === 'Enter' || event.key === ' ') && hover) {
      event.preventDefault()
      onplay?.(hover.x, hover.y)
    }
  }
</script>

<div class="frame" class:thinking>
  <!--
    One focusable grid rather than 225 focusable cells: arrow keys move the
    cursor, Enter places a stone, and the readout below announces the result.
  -->
  <div
    class="surface"
    role="grid"
    aria-label="Gomoku board. Arrow keys move the cursor, Enter places a stone."
    aria-rowcount={SIZE}
    aria-colcount={SIZE}
    aria-disabled={!interactive}
    tabindex={interactive ? 0 : -1}
    onmousemove={onmove}
    onmouseleave={() => (hover = null)}
    onclick={onclick}
    onkeydown={onkeydown}
  >
  <svg viewBox="0 0 {SPAN} {SPAN}" aria-hidden="true">
    <defs>
      <radialGradient id="paper" cx="42%" cy="34%" r="78%">
        <stop offset="0%" stop-color="#f1ece1" />
        <stop offset="100%" stop-color="#ddd6c6" />
      </radialGradient>
      <radialGradient id="blackStone" cx="34%" cy="30%" r="72%">
        <stop offset="0%" stop-color="#4a4f58" />
        <stop offset="45%" stop-color="#1d2026" />
        <stop offset="100%" stop-color="#0b0c0f" />
      </radialGradient>
      <radialGradient id="whiteStone" cx="34%" cy="30%" r="72%">
        <stop offset="0%" stop-color="#ffffff" />
        <stop offset="55%" stop-color="#f4efe4" />
        <stop offset="100%" stop-color="#d9d2c2" />
      </radialGradient>
      <filter id="stoneShadow" x="-60%" y="-60%" width="220%" height="220%">
        <feDropShadow dx="0.05" dy="0.11" stdDeviation="0.09" flood-color="#2a2417" flood-opacity="0.45" />
      </filter>
    </defs>

    <rect x="0" y="0" width={SPAN} height={SPAN} rx="0.7" fill="url(#paper)" />

    <g stroke="#9a9081" stroke-width="0.035" stroke-linecap="square">
      {#each Array(SIZE) as _, i}
        <line x1={PAD} y1={PAD + i} x2={PAD + SIZE - 1} y2={PAD + i} />
        <line x1={PAD + i} y1={PAD} x2={PAD + i} y2={PAD + SIZE - 1} />
      {/each}
    </g>
    <rect
      x={PAD}
      y={PAD}
      width={SIZE - 1}
      height={SIZE - 1}
      fill="none"
      stroke="#7d7364"
      stroke-width="0.07"
    />

    {#each STAR as [sx, sy]}
      <circle cx={PAD + sx} cy={PAD + sy} r="0.12" fill="#7d7364" />
    {/each}

    <g class="coords" fill="#8b8274" font-size="0.42" font-family="'JetBrains Mono', monospace">
      {#each Array(SIZE) as _, i}
        <text x={PAD + i} y={PAD - 0.55} text-anchor="middle">{COLS[i]}</text>
        <text x={PAD - 0.6} y={PAD + i + 0.15} text-anchor="middle">{SIZE - i}</text>
      {/each}
    </g>

    {#if thinking}
      <g class="candidates">
        {#each candidates as c, i}
          <circle
            cx={PAD + c.x}
            cy={PAD + c.y}
            r="0.42"
            fill="none"
            stroke="#d98e2b"
            stroke-width="0.07"
            opacity={Math.max(0.2, 1 - i * 0.1)}
            style="animation-delay: {i * 70}ms"
          />
        {/each}
      </g>
    {/if}

    {#each stones as stone (stone.key)}
      <g class="stone" class:winner={stone.winner} class:fresh={stone.fresh} filter="url(#stoneShadow)">
        <circle
          cx={PAD + stone.x}
          cy={PAD + stone.y}
          r="0.44"
          fill={stone.color === BLACK ? 'url(#blackStone)' : 'url(#whiteStone)'}
        />
        {#if stone.winner}
          <circle cx={PAD + stone.x} cy={PAD + stone.y} r="0.44" fill="none" stroke="#d98e2b" stroke-width="0.09" />
        {/if}
        {#if stone.fresh && !stone.winner}
          <circle
            cx={PAD + stone.x}
            cy={PAD + stone.y}
            r="0.13"
            fill={stone.color === BLACK ? '#e9e3d6' : '#1d2026'}
            opacity="0.85"
          />
        {/if}
      </g>
    {/each}

    {#if hover && interactive && board[idx(hover.x, hover.y)] === EMPTY}
      <g class="ghost" class:illegal={hoverLegality && !hoverLegality.legal}>
        <circle
          cx={PAD + hover.x}
          cy={PAD + hover.y}
          r="0.44"
          fill={turn === BLACK ? '#14161a' : '#f6f2e8'}
          opacity="0.32"
        />
        {#if hoverLegality && !hoverLegality.legal && hoverLegality.reason !== 'occupied'}
          <g stroke="#c0392b" stroke-width="0.09" stroke-linecap="round">
            <line x1={PAD + hover.x - 0.24} y1={PAD + hover.y - 0.24} x2={PAD + hover.x + 0.24} y2={PAD + hover.y + 0.24} />
            <line x1={PAD + hover.x + 0.24} y1={PAD + hover.y - 0.24} x2={PAD + hover.x - 0.24} y2={PAD + hover.y + 0.24} />
          </g>
        {/if}
      </g>
    {/if}
  </svg>

    {#if awaitingStart}
      <div class="gate">
        <button type="button" onclick={onstart}>{startLabel}</button>
        {#if startCaption}
          <p>{startCaption}</p>
        {/if}
      </div>
    {/if}
  </div>

  <p class="readout" aria-live="polite">
    {#if hover && interactive}
      {#if hoverLegality && !hoverLegality.legal && hoverLegality.reason !== 'occupied'}
        <span class="illegal-note">{coordLabel(hover.x, hover.y)} is forbidden here</span>
      {:else}
        <span class="tnum">{coordLabel(hover.x, hover.y)}</span>
      {/if}
    {:else if lastMove}
      <span>Last move <span class="tnum">{coordLabel(lastMove.x, lastMove.y)}</span></span>
    {:else}
      <span>Black opens.</span>
    {/if}
  </p>
</div>

<style>
  .frame {
    display: grid;
    gap: 0.75rem;
    justify-items: center;
  }

  .surface {
    position: relative;
    width: 100%;
    max-width: min(640px, 72vh);
    border-radius: var(--radius);
    box-shadow: var(--shadow-lift);
    cursor: crosshair;
    touch-action: manipulation;
    line-height: 0;
  }

  /*
   * The board is the subject, so the veil is thin enough to keep the grid and
   * the star points readable — a waiting board, not a splash screen over one.
   * The control is small for the same reason: amber is the only accent this
   * design has, and a play button the size of a third of the board spends all
   * of it on the least interesting moment of the game.
   */
  .gate {
    position: absolute;
    inset: 0;
    display: grid;
    align-content: center;
    justify-items: center;
    gap: 0.6rem;
    border-radius: inherit;
    background: rgb(233 227 214 / 0.55);
    animation: veil 220ms var(--ease-out) both;
  }

  @keyframes veil {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  .gate button {
    white-space: nowrap;
    line-height: 1;
    background: var(--ink-850);
    border: none;
    border-radius: var(--radius-sm);
    padding: 0.62rem 1.05rem;
    font-family: var(--font-ui);
    font-size: 0.8125rem;
    font-weight: 600;
    letter-spacing: 0.01em;
    color: var(--paper);
    cursor: pointer;
    box-shadow: var(--shadow-soft);
    transition:
      background 160ms var(--ease-out),
      color 160ms var(--ease-out);
  }

  .gate button:hover {
    background: var(--ink-900);
    color: var(--amber-hi);
  }

  .gate p {
    margin: 0;
    max-width: 22ch;
    text-align: center;
    font-family: var(--font-ui);
    font-size: 0.75rem;
    line-height: 1.5;
    color: #6b6355;
  }

  .surface[aria-disabled='true'] {
    cursor: default;
  }

  svg {
    width: 100%;
    height: auto;
    display: block;
    border-radius: inherit;
  }

  .stone.fresh circle {
    animation: settle 340ms var(--ease-out) both;
  }

  .stone.winner circle {
    animation: none;
  }

  @keyframes settle {
    from {
      transform: scale(0.55);
      opacity: 0;
    }
    to {
      transform: scale(1);
      opacity: 1;
    }
  }

  .stone circle {
    transform-box: fill-box;
    transform-origin: center;
  }

  .candidates circle {
    animation: pulse 1.4s var(--ease-out) infinite;
    transform-box: fill-box;
    transform-origin: center;
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 0.18;
      transform: scale(0.82);
    }
    45% {
      opacity: 0.9;
      transform: scale(1);
    }
  }

  .readout {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--text-lo);
    letter-spacing: 0.01em;
  }

  .illegal-note {
    color: var(--rose);
  }

  .coords {
    user-select: none;
  }
</style>

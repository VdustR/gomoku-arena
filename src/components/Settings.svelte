<script>
  import { settings, persist, forgetEverything, keyFingerprint } from '../lib/settings.svelte.js'
  import { PROVIDERS, JEV_ID, OPENAI_ID } from '../lib/ai/providers.ts'
  import { serverCovers, serverProblem } from '../lib/relay.svelte.js'

  let { open = $bindable(false), browserModel } = $props()

  let dialog = $state(null)
  let revealed = $state({ jev: false, openai: false })

  // The three implementations of this wire API, as of writing.
  const JEV_PRESETS = [
    { name: 'TypeSafe', baseUrl: 'https://api.typesafe.ai/v1', model: 'jev-latest' },
    { name: 'localjev', baseUrl: 'http://127.0.0.1:8080/v1', model: 'localjev-latest' },
    { name: 'openjev', baseUrl: 'http://127.0.0.1:8000/v1', model: 'openjev-latest' },
  ]

  function applyJevPreset(preset) {
    settings.jevBaseUrl = preset.baseUrl
    settings.jevModel = preset.model
  }

  $effect(() => {
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  })

  function save() {
    persist()
    open = false
  }

  function forget() {
    forgetEverything()
    revealed = { jev: false, openai: false }
  }
</script>

<dialog bind:this={dialog} onclose={() => (open = false)}>
  <form method="dialog" onsubmit={save}>
    <header>
      <h2>Your keys, your browser</h2>
      <button type="button" class="close" onclick={() => (open = false)} aria-label="Close settings">
        <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>
    </header>

    <p class="lede">
      Nothing here ships with a key. A key can come from two places: this browser, or the environment of the
      server you started. What you enter here wins, is kept in this browser’s localStorage, and is sent only
      with the move it pays for. Remote providers pass through the relay on that server — it forwards one
      request and keeps no copy. Everything stays on your machine and the provider’s.
    </p>

    <section>
      <div class="head">
        <h3>{PROVIDERS[JEV_ID].name}</h3>
        {#if settings.jevKey}
          <span class="fingerprint tnum">{keyFingerprint(settings.jevKey)}</span>
        {:else if serverCovers(JEV_ID)}
          <span class="from-server">key on the server</span>
        {:else}
          <span class="absent">no key</span>
        {/if}
      </div>
      {#if serverProblem(JEV_ID)}
        <p class="server-problem">{serverProblem(JEV_ID)}</p>
      {:else if serverCovers(JEV_ID)}
        <p class="hint">
          The server holds a key for this provider and pins where it is spent, so you can play without entering
          one. A key typed below is used instead, with the base URL and model set here.
        </p>
      {/if}
      <label>
        <span>API key</span>
        <div class="field">
          <input
            type={revealed.jev ? 'text' : 'password'}
            bind:value={settings.jevKey}
            placeholder="Paste a key, or anything your own server accepts"
            autocomplete="off"
            spellcheck="false"
          />
          <button type="button" onclick={() => (revealed.jev = !revealed.jev)}>
            {revealed.jev ? 'Hide' : 'Show'}
          </button>
        </div>
      </label>
      <div class="pair">
        <label>
          <span>Base URL</span>
          <input bind:value={settings.jevBaseUrl} spellcheck="false" autocomplete="off" />
        </label>
        <label>
          <span>Model</span>
          <input bind:value={settings.jevModel} spellcheck="false" autocomplete="off" />
        </label>
      </div>
      <div class="presets">
        {#each JEV_PRESETS as preset}
          <button type="button" onclick={() => applyJevPreset(preset)}>{preset.name}</button>
        {/each}
      </div>
      <p class="hint">
        Anything serving <code>POST /v1/systemone</code>. TypeSafe, <code>localjev</code>, and
        <code>openjev</code> all accept <code>jev-latest</code>. TypeSafe refuses browser origins outright, so
        this provider always goes through the relay.
      </p>
    </section>

    <section>
      <div class="head">
        <h3>{PROVIDERS[OPENAI_ID].name}</h3>
        {#if settings.openaiKey}
          <span class="fingerprint tnum">{keyFingerprint(settings.openaiKey)}</span>
        {:else if serverCovers(OPENAI_ID)}
          <span class="from-server">key on the server</span>
        {:else}
          <span class="absent">no key</span>
        {/if}
      </div>
      {#if serverProblem(OPENAI_ID)}
        <p class="server-problem">{serverProblem(OPENAI_ID)}</p>
      {:else if serverCovers(OPENAI_ID)}
        <p class="hint">
          The server holds a key for this provider and pins where it is spent, so you can play without entering
          one. A key typed below is used instead, with the base URL and model set here.
        </p>
      {/if}
      <label>
        <span>API key</span>
        <div class="field">
          <input
            type={revealed.openai ? 'text' : 'password'}
            bind:value={settings.openaiKey}
            placeholder="sk-…"
            autocomplete="off"
            spellcheck="false"
          />
          <button type="button" onclick={() => (revealed.openai = !revealed.openai)}>
            {revealed.openai ? 'Hide' : 'Show'}
          </button>
        </div>
      </label>
      <div class="pair">
        <label>
          <span>Base URL</span>
          <input bind:value={settings.openaiBaseUrl} spellcheck="false" autocomplete="off" />
        </label>
        <label>
          <span>Model</span>
          <input bind:value={settings.openaiModel} spellcheck="false" autocomplete="off" />
        </label>
      </div>
      <p class="hint">Any endpoint that speaks <code>/chat/completions</code>. An http address is allowed on localhost.</p>
    </section>

    <section class="browser">
      <div class="head">
        <h3>{PROVIDERS.browser.name}</h3>
        <span class:ready={browserModel?.ready} class:absent={!browserModel?.supported} class="state">
          {browserModel?.state ?? 'checking'}
        </span>
      </div>
      <p class="hint">{browserModel?.detail ?? 'Checking whether this browser exposes the Prompt API.'}</p>
    </section>

    <footer>
      <button type="button" class="ghost" onclick={forget}>Forget everything</button>
      <button type="submit" class="primary">Save</button>
    </footer>
  </form>
</dialog>

<style>
  dialog {
    border: 1px solid var(--ink-600);
    border-radius: var(--radius-lg);
    background: var(--ink-800);
    color: var(--text);
    padding: 0;
    width: min(34rem, calc(100vw - 2rem));
    box-shadow: var(--shadow-lift);
  }

  dialog::backdrop {
    background: rgb(4 5 8 / 0.7);
    backdrop-filter: blur(3px);
  }

  form {
    display: grid;
    gap: 1.5rem;
    padding: 1.5rem;
  }

  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
  }

  h2 {
    font-family: var(--font-display);
    font-size: 1.6rem;
    line-height: 1.2;
  }

  h3 {
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--text-hi);
  }

  .close {
    background: none;
    border: none;
    color: var(--text-lo);
    padding: 0.35rem;
    border-radius: var(--radius-sm);
    cursor: pointer;
    display: grid;
    place-items: center;
  }
  .close:hover {
    color: var(--text-hi);
    background: var(--ink-700);
  }

  .lede {
    margin: 0;
    font-size: 0.875rem;
    color: var(--text-lo);
    line-height: 1.65;
  }

  section {
    display: grid;
    gap: 0.6rem;
    padding-top: 1.25rem;
    border-top: 1px solid var(--ink-700);
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .fingerprint {
    font-size: 0.75rem;
    color: var(--teal-hi);
  }

  .absent {
    font-size: 0.75rem;
    color: var(--text-lo);
  }

  /* A key the server holds is usable but not yours to see, so it reads as a
     source rather than as a fingerprint of something in this browser. */
  .from-server {
    font-size: 0.75rem;
    color: var(--text-lo);
    font-style: italic;
  }

  .server-problem {
    margin: 0;
    font-size: 0.8125rem;
    line-height: 1.6;
    color: #eddcc2;
    background: color-mix(in srgb, var(--amber) 12%, var(--ink-800));
    border-radius: var(--radius-sm);
    padding: 0.55rem 0.75rem;
  }

  .state {
    font-size: 0.75rem;
    font-family: var(--font-data);
    color: var(--text-lo);
  }
  .state.ready {
    color: var(--teal-hi);
  }

  label {
    display: grid;
    gap: 0.35rem;
  }

  label > span {
    font-size: 0.75rem;
    color: var(--text-lo);
    letter-spacing: 0.02em;
  }

  .field {
    display: flex;
    gap: 0.5rem;
  }

  input {
    flex: 1;
    min-width: 0;
    background: var(--ink-850);
    border: 1px solid var(--ink-600);
    border-radius: var(--radius-sm);
    padding: 0.55rem 0.7rem;
    font-size: 0.875rem;
    font-family: var(--font-data);
    transition: border-color 160ms var(--ease-out);
  }
  input:hover {
    border-color: var(--ink-500);
  }
  input::placeholder {
    color: #6e7486;
    font-family: var(--font-ui);
  }

  .field button {
    background: var(--ink-700);
    border: 1px solid var(--ink-600);
    border-radius: var(--radius-sm);
    padding: 0 0.75rem;
    font-size: 0.8125rem;
    color: var(--text);
    cursor: pointer;
  }
  .field button:hover {
    background: var(--ink-600);
    color: var(--text-hi);
  }

  .pair {
    display: grid;
    gap: 0.75rem;
    grid-template-columns: 1fr 1fr;
  }

  .hint {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--text-lo);
    line-height: 1.6;
  }

  .presets {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }

  .presets button {
    background: var(--ink-850);
    border: 1px solid var(--ink-600);
    border-radius: 99px;
    padding: 0.28rem 0.7rem;
    font-size: 0.75rem;
    color: var(--text-lo);
    cursor: pointer;
    transition:
      border-color 160ms var(--ease-out),
      color 160ms var(--ease-out);
  }
  .presets button:hover {
    border-color: var(--teal);
    color: var(--teal-hi);
  }

  code {
    font-family: var(--font-data);
    font-size: 0.8125em;
    color: var(--teal-hi);
  }

  footer {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    padding-top: 1.25rem;
    border-top: 1px solid var(--ink-700);
  }

  .ghost,
  .primary {
    border-radius: var(--radius-sm);
    padding: 0.6rem 1.1rem;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    transition:
      background 160ms var(--ease-out),
      color 160ms var(--ease-out);
  }

  .ghost {
    background: none;
    border: 1px solid var(--ink-600);
    color: var(--text-lo);
  }
  .ghost:hover {
    color: var(--rose);
    border-color: var(--rose);
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

  @media (max-width: 30rem) {
    .pair {
      grid-template-columns: 1fr;
    }
  }
</style>

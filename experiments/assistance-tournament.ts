/**
 * Play every pairing of assistance levels, both colours, and record each game.
 *
 *   node experiments/assistance-tournament.ts [out-dir] [concurrency]
 *
 * The question this answers is not "which model is better" — it is the same
 * model throughout. It is "how much of a shortlisted seat's play is the
 * model, and how much is the heuristic feeding it". So the entrants are one
 * model at three assistance levels, plus the heuristic itself as a baseline,
 * because that heuristic is what the assisted seats are quietly using and a
 * seat that cannot beat it has contributed nothing.
 *
 * Each match drives and records itself: one headless page sets both seats,
 * arms the board and plays it out while the same page is being filmed. The
 * page has to be armed before the start gate is hidden, which is the one
 * ordering constraint in here.
 */

import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { PublicMatch, Review } from '../server/match.ts'

const OUT_DIR = resolve(process.argv[2] ?? 'out/assistance')
const CONCURRENCY = Number(process.argv[3] ?? 3)
const BASE = process.env['GOMOKU_URL'] ?? 'http://localhost:5273'
const SIZE = { width: 1280, height: 860 }
const MAX_MS = Number(process.env['MATCH_MAX_MS'] ?? 20 * 60 * 1000)

/** The entrants, by the provider id the seat picker uses. */
const PLAYERS: Record<string, string> = {
  jev: 'Jev — assisted',
  'jev-shortlisted': 'Jev — shortlisted',
  'jev-unaided': 'Jev — unaided',
  greedy: 'Greedy heuristic',
}

const IDS = Object.keys(PLAYERS)

/** Every unordered pair, played twice so each side gets black once. */
function fixtures(): { black: string; white: string; tag: string }[] {
  const out: { black: string; white: string; tag: string }[] = []
  for (let i = 0; i < IDS.length; i += 1) {
    for (let j = i + 1; j < IDS.length; j += 1) {
      const a = IDS[i] as string
      const b = IDS[j] as string
      out.push({ black: a, white: b, tag: `${a}__vs__${b}` })
      out.push({ black: b, white: a, tag: `${b}__vs__${a}` })
    }
  }
  return out
}

const short = (id: string) => id.replace('jev-', '').replace('jev', 'assisted')

async function createMatch(black: string, white: string): Promise<string> {
  const response = await fetch(`${BASE}/api/match`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ruleSet: 'free',
      black: { kind: 'engine', label: PLAYERS[black] },
      white: { kind: 'engine', label: PLAYERS[white] },
    }),
  })
  if (!response.ok) throw new Error(`could not open a match: ${response.status}`)
  return ((await response.json()) as PublicMatch).id
}

/** Point the page's two seat pickers at the providers this fixture wants. */
async function seat(page: Page, black: string, white: string): Promise<void> {
  const settled = await page.evaluate(
    ({ black, white }) => {
      const selects = [...document.querySelectorAll('select')]
      const [b, w] = selects
      if (!b || !w) return null
      for (const [select, value] of [
        [b, black],
        [w, white],
      ] as const) {
        if (select.value !== value) {
          select.value = value
          select.dispatchEvent(new Event('change', { bubbles: true }))
        }
      }
      return [b.value, w.value]
    },
    { black, white },
  )
  if (!settled) throw new Error('the page has no seat pickers')
  if (settled[0] !== black || settled[1] !== white) {
    throw new Error(`seats did not take: wanted ${black}/${white}, got ${settled.join('/')}`)
  }
}

/**
 * Press Start, and keep pressing.
 *
 * The gate only appears on the turn of a seat this page drives, and arming is
 * per-tab rather than per-match, so a single click at the top is not enough
 * when the board changes hands. The interval is cheap and stops with the page.
 */
async function arm(page: Page): Promise<void> {
  await page.evaluate(() => {
    const press = () => {
      const gate = [...document.querySelectorAll('button')].find((b) =>
        ['Start', 'Resume'].includes((b.textContent ?? '').trim()),
      )
      gate?.click()
    }
    press()
    setInterval(press, 1000)
  })
}

/** Everything the recorder does to stop filming the controls. See record-match. */
async function dress(page: Page, review: Review): Promise<void> {
  const label = (side: 'black' | 'white') => review.sides[side].player.label ?? review.sides[side].player.kind
  await page.addStyleTag({ content: '.gate { display: none !important; }' })
  await page.evaluate(
    ({ matchup, black, white }) => {
      const heading = () =>
        [...document.querySelectorAll('main *')].find(
          (el) => el.children.length === 0 && / vs /.test(el.textContent ?? ''),
        )
      const set = (el: Element | undefined, text: string) => {
        if (el && el.textContent !== text) el.textContent = text
      }
      const apply = () => {
        set(heading(), matchup)
        const seats = document.querySelectorAll('.who > .name')
        if (seats.length === 2) {
          set(seats[0], black)
          set(seats[1], white)
        }
        for (const section of document.querySelectorAll('section')) {
          const h = section.querySelector('h1, h2, h3, h4')
          if (h && /change a seat/i.test(h.textContent ?? '')) {
            ;(section as HTMLElement).style.display = 'none'
          }
        }
      }
      apply()
      setInterval(apply, 400)
    },
    { matchup: `${label('black')} vs ${label('white')}`, black: label('black'), white: label('white') },
  )
}

async function toMp4(webm: string, out: string): Promise<void> {
  await new Promise<void>((done, failed) => {
    const ff = spawn(
      'ffmpeg',
      // prettier-ignore
      ['-y', '-i', webm, '-c:v', 'libx264', '-preset', 'medium', '-crf', '26',
       '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-vf', 'scale=1280:-2', out],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    )
    let err = ''
    ff.stderr.on('data', (d: Buffer) => (err += String(d)))
    ff.on('exit', (code) => (code === 0 ? done() : failed(new Error(err.slice(-500)))))
  })
  rmSync(webm, { force: true })
}

interface Played {
  tag: string
  id: string
  black: string
  white: string
  status: string
  winner: string | null
  moves: number
  video: string
}

async function playOne(browser: Browser, fx: { black: string; white: string; tag: string }): Promise<Played> {
  const id = await createMatch(fx.black, fx.white)
  const raw = resolve(OUT_DIR, 'raw')
  mkdirSync(raw, { recursive: true })
  const context = await browser.newContext({
    viewport: SIZE,
    deviceScaleFactor: 2,
    recordVideo: { dir: raw, size: SIZE },
  })
  const page = await context.newPage()
  await page.goto(`${BASE}/#match=${id}`, { waitUntil: 'networkidle' })

  await seat(page, fx.black, fx.white)
  const opening = (await (await fetch(`${BASE}/api/match/${id}/review`)).json()) as Review
  // Arm first: hiding the gate would leave nothing to press.
  await arm(page)
  await dress(page, opening)
  await page.evaluate(() => {
    document.querySelector('main')?.scrollIntoView({ block: 'start' })
    window.scrollBy(0, -12)
  })

  const started = Date.now()
  let last = ''
  for (;;) {
    if (Date.now() - started > MAX_MS) break
    const state = (await (await fetch(`${BASE}/api/match/${id}`)).json()) as PublicMatch
    if (state.status !== 'playing') break
    const now = `${state.moves}`
    if (now !== last) last = now
    await page.waitForTimeout(1000)
  }
  await page.waitForTimeout(4000)

  const video = page.video()
  await context.close()
  const out = resolve(OUT_DIR, `${short(fx.black)}-black__vs__${short(fx.white)}-white.mp4`)
  if (video) await toMp4(await video.path(), out)

  const review = (await (await fetch(`${BASE}/api/match/${id}/review`)).json()) as Review
  const line = `${short(fx.black)} (B) vs ${short(fx.white)} (W)`
  console.log(`  done  ${line.padEnd(44)} ${review.status} ${review.winner ?? ''} in ${review.moves.length}`)
  return {
    tag: fx.tag,
    id,
    black: fx.black,
    white: fx.white,
    status: review.status,
    winner: review.winner,
    moves: review.moves.length,
    video: out,
  }
}

mkdirSync(OUT_DIR, { recursive: true })
const browser = await chromium.launch()
const queue = fixtures()
console.log(`${queue.length} matches, ${CONCURRENCY} at a time`)

const done: Played[] = []
let next = 0
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const mine = next++
      const fx = queue[mine]
      if (!fx) return
      try {
        done.push(await playOne(browser, fx))
      } catch (error) {
        console.error(`  FAILED ${fx.tag}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }),
)
await browser.close()

writeFileSync(resolve(OUT_DIR, 'matches.json'), JSON.stringify(done, null, 2))
console.log(`\n${done.length} of ${queue.length} finished; ids in ${OUT_DIR}/matches.json`)

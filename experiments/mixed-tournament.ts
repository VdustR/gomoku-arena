/**
 * Run a cross table where some seats are in-page and some are agents.
 *
 *   node experiments/mixed-tournament.ts <fixtures.json> <out-dir> [concurrency]
 *
 * An in-page seat is driven by the headless page this script opens. An agent
 * seat is driven by something else entirely — a harness on the other end of
 * MCP — so for those this script only opens the match, films it, and waits.
 *
 * The fixture file is a list of `{ black, white }`, each either a provider id
 * ("jev-unaided") or "agent:<label>". Writing the pairings down rather than
 * generating them is deliberate: an agent seat has to be started by hand, and
 * a list that can be edited between runs is what lets that happen in batches.
 */

import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { PublicMatch, Review } from '../server/match.ts'

const FIXTURES = process.argv[2]
const OUT_DIR = resolve(process.argv[3] ?? 'out/cross')
const CONCURRENCY = Number(process.argv[4] ?? 3)
const BASE = process.env['GOMOKU_URL'] ?? 'http://localhost:5273'
const SIZE = { width: 1280, height: 860 }
const MAX_MS = Number(process.env['MATCH_MAX_MS'] ?? 60 * 60 * 1000)

if (!FIXTURES) {
  console.error('usage: node experiments/mixed-tournament.ts <fixtures.json> <out-dir> [concurrency]')
  process.exit(2)
}

export const NAMES: Record<string, string> = {
  'jev-unaided': 'Jev — unaided',
  'jev-shortlisted': 'Jev — shortlisted',
  browser: 'Chrome built-in',
  'agent:sonnet': 'Claude Code Sonnet',
  'agent:antigravity': 'Antigravity Gemini 3.8 Flash',
}

interface Fixture {
  black: string
  white: string
}

const isAgent = (seat: string) => seat.startsWith('agent:')
const slug = (seat: string) => seat.replace('agent:', '').replace('jev-', '')

async function createMatch(fx: Fixture): Promise<string> {
  const seatOf = (id: string) => ({
    kind: isAgent(id) ? 'agent' : 'engine',
    label: NAMES[id] ?? id,
  })
  const response = await fetch(`${BASE}/api/match`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ruleSet: 'free', black: seatOf(fx.black), white: seatOf(fx.white) }),
  })
  if (!response.ok) throw new Error(`could not open a match: ${response.status}`)
  return ((await response.json()) as PublicMatch).id
}

/**
 * Point the page's seat pickers at what each seat actually is.
 *
 * An agent seat is set to "agent" so the page leaves it alone; setting it to a
 * provider would have this page racing the real harness for the same turn.
 */
async function seat(page: Page, fx: Fixture): Promise<void> {
  const want = {
    black: isAgent(fx.black) ? 'agent' : fx.black,
    white: isAgent(fx.white) ? 'agent' : fx.white,
  }
  const got = await page.evaluate((want) => {
    const [b, w] = [...document.querySelectorAll('select')]
    if (!b || !w) return null
    for (const [select, value] of [
      [b, want.black],
      [w, want.white],
    ] as const) {
      if (select.value !== value) {
        select.value = value
        select.dispatchEvent(new Event('change', { bubbles: true }))
      }
    }
    return [b.value, w.value]
  }, want)
  if (!got) throw new Error('the page has no seat pickers')
  if (got[0] !== want.black || got[1] !== want.white) {
    throw new Error(`seats did not take: wanted ${want.black}/${want.white}, got ${got.join('/')}`)
  }
}

/** Press Start, and keep pressing: the gate returns whenever the board turns. */
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

/** Stop filming the controls; the seats are already named by the server. */
async function dress(page: Page): Promise<void> {
  await page.addStyleTag({ content: '.gate { display: none !important; }' })
  await page.evaluate(() => {
    const hide = () => {
      for (const section of document.querySelectorAll('section')) {
        const h = section.querySelector('h1, h2, h3, h4')
        if (h && /change a seat/i.test(h.textContent ?? '')) {
          ;(section as HTMLElement).style.display = 'none'
        }
      }
    }
    hide()
    setInterval(hide, 400)
  })
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

interface Played extends Fixture {
  id: string
  status: string
  winner: string | null
  moves: number
  video: string
}

async function playOne(browser: Browser, fx: Fixture): Promise<Played> {
  const id = await createMatch(fx)
  const label = `${slug(fx.black)} (B) vs ${slug(fx.white)} (W)`
  console.log(`  open  ${label.padEnd(46)} ${id}`)

  const raw = resolve(OUT_DIR, 'raw')
  mkdirSync(raw, { recursive: true })
  const context = await browser.newContext({
    viewport: SIZE,
    deviceScaleFactor: 2,
    recordVideo: { dir: raw, size: SIZE },
  })
  const page = await context.newPage()
  await page.goto(`${BASE}/#match=${id}`, { waitUntil: 'networkidle' })
  await seat(page, fx)
  // Arm before hiding the gate, or there is nothing left to press.
  await arm(page)
  await dress(page)
  await page.evaluate(() => {
    document.querySelector('main')?.scrollIntoView({ block: 'start' })
    window.scrollBy(0, -12)
  })

  const started = Date.now()
  for (;;) {
    if (Date.now() - started > MAX_MS) {
      console.log(`  TIME  ${label}`)
      break
    }
    const state = (await (await fetch(`${BASE}/api/match/${id}`)).json()) as PublicMatch
    if (state.status !== 'playing') break
    await page.waitForTimeout(1500)
  }
  await page.waitForTimeout(4000)

  const video = page.video()
  await context.close()
  const out = resolve(OUT_DIR, `${slug(fx.black)}-B__vs__${slug(fx.white)}-W.mp4`)
  if (video) await toMp4(await video.path(), out)

  const review = (await (await fetch(`${BASE}/api/match/${id}/review`)).json()) as Review
  console.log(`  done  ${label.padEnd(46)} ${review.status} ${review.winner ?? ''} in ${review.moves.length}`)
  return {
    ...fx,
    id,
    status: review.status,
    winner: review.winner,
    moves: review.moves.length,
    video: out,
  }
}

const fixtures = JSON.parse(readFileSync(FIXTURES, 'utf8')) as Fixture[]
mkdirSync(OUT_DIR, { recursive: true })
const resultsFile = resolve(OUT_DIR, 'matches.json')

/**
 * Merge this run's results into the file rather than replacing it.
 *
 * Two of these run at once whenever a batch is split across harnesses, and
 * each one reads the file when it starts. Writing back the array it started
 * with then drops every match the other process finished in between — which
 * silently lost four completed games, because the matches themselves were
 * safe on the server and only the index was short. Re-reading immediately
 * before each write, keyed by match id, makes a late write additive rather
 * than authoritative.
 */
function record(entry: Played): void {
  const onDisk: Played[] = existsSync(resultsFile)
    ? (JSON.parse(readFileSync(resultsFile, 'utf8')) as Played[])
    : []
  const byId = new Map(onDisk.map((m) => [m.id, m]))
  byId.set(entry.id, entry)
  writeFileSync(resultsFile, JSON.stringify([...byId.values()], null, 2))
}

const done: Played[] = []

const browser = await chromium.launch()
console.log(`${fixtures.length} matches, ${CONCURRENCY} at a time`)
let next = 0
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, fixtures.length) }, async () => {
    for (;;) {
      const fx = fixtures[next++]
      if (!fx) return
      try {
        const result = await playOne(browser, fx)
        done.push(result)
        // Recorded as each one finishes: an agent run is long enough that
        // losing the whole table to one crash at the end would be a real cost.
        record(result)
      } catch (error) {
        console.error(
          `  FAILED ${fx.black} vs ${fx.white}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }),
)
await browser.close()
console.log(`\n${done.length} recorded; ids in ${resultsFile}`)

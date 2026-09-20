/**
 * Record a live match as it is played.
 *
 * The board is driven by agents outside this process, so there is nothing to
 * script: the page is opened in headless Chromium and simply watched until
 * the match ends. Headless keeps the recording off the real screen — no
 * window focus taken, no pointer moved, nothing else composited into frame.
 *
 *   node experiments/record-match.ts <match-id> [out.mp4]
 */

import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { PublicMatch, Review, SeatName } from '../server/match.ts'

const MATCH = process.argv[2]
const OUT = resolve(process.argv[3] ?? `out/match-${MATCH}.mp4`)
const BASE = process.env['GOMOKU_URL'] ?? 'http://localhost:5273'
const SIZE = { width: 1280, height: 860 }
const MAX_MS = Number(process.env['RECORD_MAX_MS'] ?? 45 * 60 * 1000)

if (!MATCH) {
  console.error('usage: node experiments/record-match.ts <match-id> [out.mp4]')
  process.exit(2)
}

const RAW = resolve('out/raw')
mkdirSync(RAW, { recursive: true })
mkdirSync(dirname(OUT), { recursive: true })

const browser = await chromium.launch()
const context = await browser.newContext({
  viewport: SIZE,
  deviceScaleFactor: 2,
  recordVideo: { dir: RAW, size: SIZE },
})
const page = await context.newPage()
await page.goto(`${BASE}/#match=${MATCH}`, { waitUntil: 'networkidle' })

/*
 * A recorder is a spectator, and the page does not know that.
 *
 * Two things it renders for whoever is sitting at it made the first
 * recordings misleading rather than merely untidy:
 *
 * 1. The start gate. Any seat the page *could* drive puts a Start button —
 *    "Resume" once a stone has landed — in the middle of the board. This tab
 *    never arms itself, so the button is dead, but it sat over the centre of
 *    the position for the whole of a 127-move game.
 *
 * 2. The matchup line. For a seat the server calls an engine the page names
 *    its own local provider pick, not the seat the match is actually being
 *    played by. A fresh profile defaults both seats to the on-device model,
 *    so a jev-versus-Chrome game was captioned "Chrome built-in AI vs Chrome
 *    built-in AI".
 *
 * Neither is fixed here by changing what the page believes. The gate is
 * hidden, and the caption is taken from the server's own record — the same
 * labels `review` reports — so the video agrees with the record it documents.
 */
const review = await fetch(`${BASE}/api/match/${MATCH}/review`)
  .then((r) => (r.ok ? (r.json() as Promise<Review>) : null))
  .catch(() => null)
const seatLabel = (side: SeatName): string => {
  const player = review?.sides[side]?.player
  return player?.label ?? player?.kind ?? side
}
const matchup = review ? `${seatLabel('black')} vs ${seatLabel('white')}` : null

await page.addStyleTag({ content: '.gate { display: none !important; }' })
if (review) {
  await page.evaluate(
    ({ matchup, black, white }: { matchup: string | null; black: string; white: string }) => {
      const heading = (): Element | undefined =>
        [...document.querySelectorAll('main *')].find(
          (el) => el.children.length === 0 && / vs /.test(el.textContent ?? ''),
        )
      const set = (el: Element | undefined, text: string | null): void => {
        if (el && el.textContent !== text) el.textContent = text
      }
      /*
       * Svelte owns these nodes and rewrites them on every sync, so the labels
       * are re-applied rather than set once. The two seat names in "this match"
       * are black then white in document order; the moves list below them uses
       * a different class and is left alone, because the name it prints per
       * move already comes from the server.
       */
      /*
       * "Change a seat" names the provider this tab would drive with, which is
       * the same local pick that mislabelled the caption. Left visible it
       * contradicts the seats printed directly above it, so the control is
       * dropped from the recording rather than corrected: a spectator has
       * nothing to change.
       */
      const hideSeatPicker = (): void => {
        for (const section of document.querySelectorAll('section')) {
          const h = section.querySelector('h1, h2, h3, h4')
          if (h && /change a seat/i.test(h.textContent ?? '')) section.style.display = 'none'
        }
      }
      const apply = (): void => {
        set(heading(), matchup)
        const seats = document.querySelectorAll('.who > .name')
        if (seats.length === 2) {
          set(seats[0], black)
          set(seats[1], white)
        }
        hideSeatPicker()
      }
      apply()
      setInterval(apply, 400)
    },
    { matchup, black: seatLabel('black'), white: seatLabel('white') },
  )
  console.log(`captioned as: ${matchup}`)
}

/*
 * Frame the game, not the pitch. The first recording opened at the top of the
 * page, so the board was cut off at the bottom and the panel never appeared —
 * ten minutes of footage with the interesting half off screen.
 */
await page.evaluate(() => {
  document.querySelector('main')?.scrollIntoView({ block: 'start' })
  window.scrollBy(0, -12)
})
await page.waitForTimeout(500)

const started = Date.now()
let lastMoves = -1
console.log(`recording ${MATCH}`)

for (;;) {
  if (Date.now() - started > MAX_MS) {
    console.log('stopping at the time limit')
    break
  }
  const response = await fetch(`${BASE}/api/match/${MATCH}`).catch(() => null)
  if (!response?.ok) {
    console.log('the match is no longer available; stopping')
    break
  }
  const state = (await response.json()) as PublicMatch
  if (state.moves !== lastMoves) {
    lastMoves = state.moves
    const last = state.history.at(-1)
    console.log(`  ${String(state.moves).padStart(3)}  ${last ? `${last.seat} ${last.point}` : 'opening'}`)
  }
  if (state.status !== 'playing') {
    console.log(`finished: ${state.status}${state.winner ? ` (${state.winner})` : ''}`)
    // Hold on the final position long enough to read it.
    await page.waitForTimeout(6000)
    break
  }
  await page.waitForTimeout(1000)
}

const video = page.video()
await context.close()
await browser.close()
if (!video) throw new Error('the context recorded no video')
const webm = await video.path()

/** Playwright writes WebM; deliver H.264 so it plays inline. */
await new Promise<void>((done, failed) => {
  const ff = spawn(
    'ffmpeg',
    [
      '-y',
      '-i',
      webm,
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '26',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      '-vf',
      'scale=1280:-2',
      OUT,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  let err = ''
  ff.stderr?.on('data', (d: Buffer) => (err += d))
  ff.on('exit', (code) => (code === 0 ? done() : failed(new Error(err.slice(-600)))))
})
rmSync(webm, { force: true })
console.log(`wrote ${OUT}`)

/**
 * Record a live match as it is played.
 *
 * The board is driven by agents outside this process, so there is nothing to
 * script: the page is opened in headless Chromium and simply watched until
 * the match ends. Headless keeps the recording off the real screen — no
 * window focus taken, no pointer moved, nothing else composited into frame.
 *
 *   node experiments/record-match.mjs <match-id> [out.mp4]
 */

import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const MATCH = process.argv[2]
const OUT = resolve(process.argv[3] ?? `out/match-${MATCH}.mp4`)
const BASE = process.env.GOMOKU_URL ?? 'http://localhost:5273'
const SIZE = { width: 1280, height: 860 }
const MAX_MS = Number(process.env.RECORD_MAX_MS ?? 45 * 60 * 1000)

if (!MATCH) {
  console.error('usage: node experiments/record-match.mjs <match-id> [out.mp4]')
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
  const state = await response.json()
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
const webm = await video.path()

/** Playwright writes WebM; deliver H.264 so it plays inline. */
await new Promise((done, failed) => {
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
  ff.stderr.on('data', (d) => (err += d))
  ff.on('exit', (code) => (code === 0 ? done() : failed(new Error(err.slice(-600)))))
})
rmSync(webm, { force: true })
console.log(`wrote ${OUT}`)

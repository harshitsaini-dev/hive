/**
 * Renders the PWA icon set from one SVG source.
 *
 * Uses the Chromium that Playwright already installs rather than adding an
 * image library — sharp and friends are native dependencies, and this runs
 * about twice a year.
 *
 *   node scripts/generate-icons.mjs
 *
 * Output goes to apps/web/public/icons/ and is committed, so a normal install
 * and build never needs Chromium.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'apps/web/public/icons')

const GOLD = '#b8801d'
const CREAM = '#faf7f0'

/**
 * `padding` is the fraction of the canvas left empty around the mark. Maskable
 * icons get a lot of it: Android crops them to whatever shape the launcher
 * uses, and only the middle 80% is guaranteed to survive.
 */
function svg({ size, padding, background }) {
  const inner = size * (1 - padding * 2)
  const offset = size * padding

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  ${background ? `<rect width="${size}" height="${size}" fill="${background}"/>` : ''}
  <g transform="translate(${offset} ${offset}) scale(${inner / 24})">
    <path d="M12 1.5 21.2 6.8v10.4L12 22.5 2.8 17.2V6.8z" fill="${GOLD}"/>
    <path d="M12 7.6 16.8 10.3v5.4L12 18.4 7.2 15.7v-5.4z" fill="${background ?? CREAM}"/>
  </g>
</svg>`
}

const TARGETS = [
  { file: 'icon-192.png', size: 192, padding: 0.06, background: CREAM },
  { file: 'icon-512.png', size: 512, padding: 0.06, background: CREAM },
  // Safe zone for launcher masking — the mark sits well inside the crop.
  { file: 'maskable-192.png', size: 192, padding: 0.18, background: CREAM },
  { file: 'maskable-512.png', size: 512, padding: 0.18, background: CREAM },
  // iOS does not honour transparency or maskable, so it gets its own opaque one.
  { file: 'apple-touch-icon.png', size: 180, padding: 0.1, background: CREAM },
]

const browser = await chromium.launch()
const page = await browser.newPage()

await mkdir(OUT, { recursive: true })

for (const target of TARGETS) {
  const markup = svg(target)

  await page.setViewportSize({ width: target.size, height: target.size })
  await page.setContent(
    `<style>html,body{margin:0;padding:0}</style>${markup}`,
    { waitUntil: 'load' },
  )

  const buffer = await page.screenshot({
    omitBackground: !target.background,
    clip: { x: 0, y: 0, width: target.size, height: target.size },
  })

  await writeFile(join(OUT, target.file), buffer)
  console.log(`wrote ${target.file} (${target.size}px)`)
}

// The favicon stays vector — browsers that support it get a crisp icon at any
// size, and the PNGs above cover everything that does not.
await writeFile(
  join(OUT, 'icon.svg'),
  svg({ size: 512, padding: 0.06, background: CREAM }),
)
console.log('wrote icon.svg')

/**
 * The link-preview card.
 *
 * 1200x630 is what Open Graph consumers crop to. Everything important stays
 * well inside the middle, because Slack, WhatsApp and Twitter each trim the
 * edges differently and some show it as a square.
 */
const INK = '#f3eee4'
const DARK = '#171512'
const MUTED = '#a89f92'

await page.setViewportSize({ width: 1200, height: 630 })
await page.setContent(
  `<style>
    html, body { margin: 0; padding: 0; }
    body {
      width: 1200px;
      height: 630px;
      display: flex;
      flex-direction: column;
      justify-content: center;
      gap: 26px;
      padding: 0 96px;
      box-sizing: border-box;
      background: ${DARK};
      color: ${INK};
      font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
    }
    /* A faint honeycomb tint bleeding in from the right, so the card is not
       a flat rectangle of text. */
    body::after {
      content: '';
      position: absolute;
      right: -140px;
      top: 50%;
      transform: translateY(-50%);
      width: 620px;
      height: 620px;
      background: radial-gradient(circle, ${GOLD}22 0%, transparent 62%);
    }
    .mark { display: flex; align-items: center; gap: 18px; }
    .mark span { font-size: 40px; font-weight: 700; letter-spacing: -0.5px; }
    h1 {
      margin: 0;
      max-width: 15ch;
      font-size: 68px;
      line-height: 1.08;
      letter-spacing: -2px;
      font-weight: 700;
    }
    p { margin: 0; max-width: 46ch; font-size: 27px; color: ${MUTED}; }
  </style>
  <div class="mark">
    <svg width="52" height="52" viewBox="0 0 24 24" fill="none"
         stroke="${GOLD}" stroke-width="1.75"
         stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 2.5 20.5 7.4v9.2L12 21.5 3.5 16.6V7.4z"/>
      <path d="M12 8.2 16.2 10.6v4.8L12 17.8 7.8 15.4v-4.8z" opacity="0.45"/>
    </svg>
    <span>Hive</span>
  </div>
  <h1>Manage several Gmail accounts from one place.</h1>
  <p>Search across all of them at once, clear the clutter in bulk, and send from any connected identity.</p>`,
  { waitUntil: 'load' },
)

await writeFile(
  join(ROOT, 'apps/web/public/og-image.png'),
  await page.screenshot({ clip: { x: 0, y: 0, width: 1200, height: 630 } }),
)
console.log('wrote og-image.png (1200x630)')

await browser.close()

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

await browser.close()

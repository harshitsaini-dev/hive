import { expect, test } from '@playwright/test'

/**
 * Browser-visible checks on the app shell.
 *
 * Split out from smoke.spec.ts because those are mostly API assertions that
 * never open a window. These are the ones worth actually watching in a headed
 * run, and they will grow into the real flows as Phase 1 lands a login form.
 */
test.describe('app shell', () => {
  test('holds its layout from mobile to desktop', async ({ page }) => {
    await page.goto('/')

    const heading = page.getByRole('heading', { name: 'Hive', level: 1 })
    await expect(heading).toBeVisible()

    for (const [label, width, height] of [
      ['mobile', 375, 667],
      ['tablet', 768, 1024],
      ['laptop', 1280, 800],
      ['desktop', 1920, 1080],
    ] as const) {
      await test.step(`${label} — ${width}px`, async () => {
        await page.setViewportSize({ width, height })

        await expect(heading).toBeVisible()
        await expect(page.getByText(/API reachable/)).toBeVisible()

        // Nothing may push the page wider than the viewport. This is the
        // failure that headless runs and desktop-only development both miss.
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        )
        expect(overflow, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(0)
      })
    }
  })

  test('is reachable and titled for a screen reader', async ({ page }) => {
    await page.goto('/')

    await expect(page).toHaveTitle(/Hive/)

    // Exactly one h1, and the page's main content in a landmark.
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
    await expect(page.getByRole('main')).toBeVisible()

    // The status box announces itself when it changes from checking to a
    // result — otherwise a screen-reader user never learns the API answered.
    await expect(page.locator('[aria-live="polite"]')).toContainText(
      /API reachable|API unreachable/,
    )
  })
})

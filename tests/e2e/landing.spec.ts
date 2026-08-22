import { expect, test } from '@playwright/test'

test.describe('landing page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('explains the product and offers a way in', async ({ page }) => {
    await expect(
      page.getByRole('heading', { name: /Manage several Gmail accounts/, level: 1 }),
    ).toBeVisible()

    await expect(page.getByRole('button', { name: 'Get started' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()

    // The honesty section is the point of the page, not decoration — if it
    // disappears, the page is making a weaker claim than the product does.
    await expect(
      page.getByRole('heading', { name: 'What Hive does not do' }),
    ).toBeVisible()
    await expect(page.getByText(/does not store your email/i)).toBeVisible()
    // Deleting is described honestly now that permanent deletion exists.
    await expect(page.getByText(/Deleting is deliberate/i)).toBeVisible()
    await expect(page.getByText(/recoverable for thirty days/i)).toBeVisible()
  })

  test('Get started opens the sign-in form, and Back returns', async ({ page }) => {
    await page.getByRole('button', { name: 'Get started' }).click()

    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
    await expect(page.getByLabel('Email address')).toBeVisible()

    await page.getByRole('button', { name: 'Back' }).click()
    await expect(
      page.getByRole('heading', { name: /Manage several Gmail accounts/ }),
    ).toBeVisible()
  })

  test('links off to other sites are not offered', async ({ page }) => {
    // The landing page deliberately keeps the visitor in one place — no
    // GitHub or source links competing with the single call to action.
    await expect(page.getByRole('link')).toHaveCount(0)
  })

  test('holds its layout from mobile to desktop', async ({ page }) => {
    for (const [label, width, height] of [
      ['mobile', 375, 667],
      ['tablet', 768, 1024],
      ['laptop', 1280, 800],
      ['desktop', 1920, 1080],
    ] as const) {
      await test.step(`${label} — ${width}px`, async () => {
        await page.setViewportSize({ width, height })

        await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
        await expect(page.getByRole('button', { name: 'Get started' })).toBeVisible()

        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        )
        expect(overflow, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(0)
      })
    }
  })
})

test.describe('theme switching', () => {
  /** What the browser actually painted, rather than what the class list says. */
  const bodyBackground = (page: import('@playwright/test').Page) =>
    page.evaluate(() => getComputedStyle(document.body).backgroundColor)

  test('switches between light and dark, and remembers the choice', async ({
    page,
  }) => {
    await page.goto('/')

    await page.getByRole('radio', { name: 'Light' }).check()
    const light = await bodyBackground(page)

    await page.getByRole('radio', { name: 'Dark' }).check()
    const dark = await bodyBackground(page)

    expect(dark).not.toBe(light)
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')

    // The choice has to survive a reload, or it is not a setting.
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    expect(await bodyBackground(page)).toBe(dark)
  })

  test('system mode defers to the OS preference', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.goto('/')

    await page.getByRole('radio', { name: 'System' }).check()

    // No stamp on the root — prefers-color-scheme decides.
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.*/)
    const whenOsDark = await bodyBackground(page)

    await page.emulateMedia({ colorScheme: 'light' })
    expect(await bodyBackground(page)).not.toBe(whenOsDark)
  })

  test('the radios keep an accessible name on narrow screens', async ({ page }) => {
    // Below 480px the visible labels are hidden to save room. The radios must
    // still be named, or a screen-reader user gets three unlabelled controls.
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto('/')

    for (const name of ['Light', 'Dark', 'System']) {
      await expect(page.getByRole('radio', { name })).toBeVisible()
    }

    await page.getByRole('radio', { name: 'Dark' }).check()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  })

  test('the toggle is available on the sign-in page too', async ({ page }) => {
    await page.goto('/?signin')

    await page.getByRole('radio', { name: 'Dark' }).check()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')

    // Carries across to the landing page — one setting, not one per screen.
    await page.getByRole('button', { name: 'Back' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  })
})

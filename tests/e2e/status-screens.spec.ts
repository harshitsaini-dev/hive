import { expect, test } from '@playwright/test'

/**
 * The screens people only see when something is wrong, which is exactly when
 * a blank page or a raw stack trace does the most damage.
 */
test.describe('status screens', () => {
  test('an unknown path shows a 404 with a way back', async ({ page }) => {
    await page.goto('/no-such-page')

    await expect(page.getByText('404')).toBeVisible()
    await expect(
      page.getByRole('heading', { name: /That page does not exist/ }),
    ).toBeVisible()

    // Says which path failed, so a mistyped link is obvious.
    await expect(page.getByText('/no-such-page')).toBeVisible()

    await page.getByRole('button', { name: 'Go to Hive' }).click()
    await expect(
      page.getByRole('heading', { name: /Manage several Gmail accounts/ }),
    ).toBeVisible()
  })

  test('losing the connection shows the offline screen', async ({ page, context }) => {
    await page.goto('/')
    await expect(
      page.getByRole('heading', { name: /Manage several Gmail accounts/ }),
    ).toBeVisible()

    await context.setOffline(true)
    // The app listens for the browser's own offline event.
    await page.evaluate(() => window.dispatchEvent(new Event('offline')))

    await expect(page.getByRole('heading', { name: /not connected/i })).toBeVisible()
    await expect(page.getByText('Offline')).toBeVisible()

    await context.setOffline(false)
    await page.evaluate(() => window.dispatchEvent(new Event('online')))

    await expect(
      page.getByRole('heading', { name: /Manage several Gmail accounts/ }),
    ).toBeVisible()
  })

  test('an API failure shows the server-error screen, not the login form', async ({
    page,
  }) => {
    // A 500 from /auth/me must never be mistaken for "not signed in" — that
    // would send a signed-in user to a login form that then also fails.
    await page.route('**/api/auth/me', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'internal_error', message: 'Something went wrong.' },
        }),
      }),
    )

    await page.goto('/')

    await expect(page.getByText('500')).toBeVisible()
    await expect(
      page.getByRole('heading', { name: /went wrong on our side/ }),
    ).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeHidden()

    // Recovering without a reload: unroute, then retry.
    await page.unroute('**/api/auth/me')
    await page.getByRole('button', { name: 'Try again' }).click()

    await expect(
      page.getByRole('heading', { name: /Manage several Gmail accounts/ }),
    ).toBeVisible()
  })

  test('a revoked session shows access denied, not a crash', async ({
    page,
    request,
  }) => {
    const email = `denied-${Date.now()}@example.test`

    await page.goto('/?signin')
    await page.getByLabel('Email address').fill(email)
    await page.getByRole('button', { name: 'Send me a code' }).click()

    const codeResponse = await request.get(
      `http://localhost:3000/auth/test/last-code?email=${encodeURIComponent(email)}`,
    )
    const { code } = (await codeResponse.json()) as { code: string }

    await page.getByLabel('Six-digit code').fill(code)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.getByRole('heading', { name: 'Connected accounts' })).toBeVisible()

    // Simulate the session ending server-side while the page is still open.
    await page.route('**/api/accounts', (route) =>
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'unauthorized', message: 'Your session has expired' },
        }),
      }),
    )

    await page.reload()

    await expect(page.getByText('403')).toBeVisible()
    await expect(page.getByRole('heading', { name: /cannot open this/i })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Sign in again' })).toBeVisible()
  })

  test('status screens keep the theme toggle reachable', async ({ page }) => {
    await page.goto('/nowhere')

    await page.getByRole('radio', { name: 'Dark' }).check()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  })
})

test.describe('installability', () => {
  test('serves a valid web app manifest', async ({ request }) => {
    const response = await request.get('http://localhost:5173/manifest.webmanifest')
    expect(response.ok()).toBe(true)

    const manifest = (await response.json()) as {
      name: string
      start_url: string
      display: string
      icons: { src: string; sizes: string; purpose: string }[]
    }

    expect(manifest.name).toContain('Hive')
    expect(manifest.start_url).toBe('/')
    // Anything other than standalone or fullscreen is not installable.
    expect(['standalone', 'fullscreen']).toContain(manifest.display)

    // Chrome requires a 192 and a 512, and a maskable one to avoid the
    // white-circle-on-Android look.
    const sizes = manifest.icons.map((icon) => icon.sizes)
    expect(sizes).toContain('192x192')
    expect(sizes).toContain('512x512')
    expect(manifest.icons.some((icon) => icon.purpose === 'maskable')).toBe(true)
  })

  test('every declared icon actually exists', async ({ request }) => {
    const manifest = (await (
      await request.get('http://localhost:5173/manifest.webmanifest')
    ).json()) as { icons: { src: string }[] }

    for (const icon of manifest.icons) {
      const response = await request.get(`http://localhost:5173${icon.src}`)
      expect(response.ok(), `${icon.src} should be served`).toBe(true)
      expect(response.headers()['content-type']).toContain('image/png')
    }
  })

  test('the page declares what an installed app needs', async ({ page }) => {
    await page.goto('/')

    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
      'href',
      '/manifest.webmanifest',
    )
    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveCount(1)

    // Both theme-colors, so the OS chrome matches either theme.
    await expect(page.locator('meta[name="theme-color"]')).toHaveCount(2)

    const viewport = await page
      .locator('meta[name="viewport"]')
      .getAttribute('content')
    expect(viewport).toContain('width=device-width')
    // Without viewport-fit=cover the safe-area insets are always zero.
    expect(viewport).toContain('viewport-fit=cover')
  })
})

test.describe('link previews', () => {
  test('declares Open Graph and Twitter card metadata', async ({ page }) => {
    await page.goto('/')

    const content = async (selector: string) =>
      page.locator(selector).getAttribute('content')

    expect(await content('meta[property="og:title"]')).toContain('Hive')
    expect(await content('meta[property="og:type"]')).toBe('website')
    expect(await content('meta[property="og:description"]')).toBeTruthy()

    // Crawlers fetch these server-side, so a relative path resolves to
    // nothing and the card renders without an image.
    for (const selector of [
      'meta[property="og:image"]',
      'meta[property="og:url"]',
      'meta[name="twitter:image"]',
    ]) {
      expect(await content(selector), `${selector} must be absolute`).toMatch(
        /^https?:\/\//,
      )
    }

    expect(await content('meta[name="twitter:card"]')).toBe('summary_large_image')
    expect(await content('meta[property="og:image:alt"]')).toBeTruthy()
  })

  test('the preview image is served at the declared size', async ({ request }) => {
    const response = await request.get('http://localhost:5173/og-image.png')
    expect(response.ok()).toBe(true)
    expect(response.headers()['content-type']).toContain('image/png')

    // 1200x630 is what the declared og:image:width/height promise. A mismatch
    // makes some consumers fall back to a small square thumbnail.
    const bytes = await response.body()
    // PNG IHDR: width and height are big-endian uint32 at offsets 16 and 20.
    expect(bytes.readUInt32BE(16)).toBe(1200)
    expect(bytes.readUInt32BE(20)).toBe(630)
  })
})

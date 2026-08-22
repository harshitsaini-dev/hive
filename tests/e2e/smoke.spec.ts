import { expect, test } from '@playwright/test'

/**
 * Boot smoke test. Proves the two dev servers start, the proxy connects them,
 * and nothing throws on first paint — the failures most likely to waste an
 * afternoon before any feature exists to test.
 */
test.describe('application boots', () => {
  test('the shell renders with no unexpected console errors', async ({ page }) => {
    const consoleErrors: string[] = []

    /**
     * The app asks /auth/me on mount to decide which page to show, and for an
     * anonymous visitor the correct answer is 401. Browsers log every failed
     * response to the console and that cannot be suppressed from script, so
     * this one is expected rather than a defect. Anything else is not.
     */
    const isExpected = (text: string) =>
      /Failed to load resource.*401/.test(text)

    page.on('console', (message) => {
      if (message.type() === 'error' && !isExpected(message.text())) {
        consoleErrors.push(message.text())
      }
    })
    page.on('pageerror', (error) => consoleErrors.push(error.message))

    await page.goto('/')

    // An anonymous visitor lands on the marketing page, not a loading state
    // stuck forever — which is what a genuinely failing /auth/me looks like.
    await expect(
      page.getByRole('heading', { name: /Manage several Gmail accounts/ }),
    ).toBeVisible()

    expect(consoleErrors).toEqual([])
  })

  test('the API reports healthy and ready', async ({ request }) => {
    const health = await request.get('http://localhost:3000/health')
    expect(health.ok()).toBe(true)
    expect(await health.json()).toMatchObject({ status: 'ok' })

    // /ready touches the database, so this also proves migrations ran.
    const ready = await request.get('http://localhost:3000/ready')
    expect(ready.ok()).toBe(true)
    expect(await ready.json()).toMatchObject({ database: 'ok' })
  })

  test('an unknown endpoint returns the standard error envelope', async ({
    request,
  }) => {
    const response = await request.get('http://localhost:3000/nope')
    expect(response.status()).toBe(404)
    expect(await response.json()).toMatchObject({
      error: { code: 'not_found' },
    })
  })
})

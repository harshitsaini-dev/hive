import { expect, test } from '@playwright/test'

/**
 * Boot smoke test. Proves the two dev servers start, the proxy connects them,
 * and nothing throws on first paint — the failures most likely to waste an
 * afternoon before any feature exists to test.
 */
test.describe('application boots', () => {
  test('the shell renders and reaches the API', async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    page.on('pageerror', (error) => consoleErrors.push(error.message))

    await page.goto('/')

    await expect(page.getByRole('heading', { name: 'Hive' })).toBeVisible()

    // The status region resolves out of "checking" once the proxy answers.
    await expect(page.getByText(/API reachable/)).toBeVisible()

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

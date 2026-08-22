import { expect, test } from '@playwright/test'

const API = 'https://localhost:3000'

/**
 * The privacy and terms pages.
 *
 * Google's OAuth reviewers read these, and the project's own rules require
 * them to describe what the code actually does. These tests assert the claims
 * that have a matching guarantee in the implementation — if someone weakens
 * one, the other should fail loudly rather than drift quietly.
 */
test.describe('privacy page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/privacy')
  })

  test('is reachable at its own URL without signing in', async ({ page }) => {
    await expect(
      page.getByRole('heading', { name: 'Privacy', level: 1 }),
    ).toBeVisible()
    // A policy you can only read once logged in is useless to a reviewer.
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeHidden()
  })

  test('states the guarantees the code actually makes', async ({ page }) => {
    // Bodies are never persisted — enforced by requesting format=metadata.
    await expect(
      page.getByText(/Message bodies and attachments are never saved/i),
    ).toBeVisible()

    // Every requested scope is named and justified.
    for (const scope of [
      'gmail.readonly',
      'gmail.modify',
      'gmail.send',
      'https://mail.google.com/',
    ]) {
      await expect(page.getByText(scope, { exact: true })).toBeVisible()
    }

    // Permanent deletion is described honestly, including that it is final.
    await expect(page.getByText(/cannot be undone by anyone/i)).toBeVisible()
    await expect(page.getByText(/cannot be scheduled/i)).toBeVisible()

    // The third parties that genuinely see data are named.
    for (const provider of ['Turso', 'Resend']) {
      await expect(page.getByText(provider).first()).toBeVisible()
    }
  })

  test('links back out to the app', async ({ page }) => {
    await page.getByRole('button', { name: 'Back' }).click()
    await expect(
      page.getByRole('heading', { name: /Manage several Gmail accounts/ }),
    ).toBeVisible()
  })
})

test.describe('terms page', () => {
  test('is reachable and warns about irreversible deletion', async ({ page }) => {
    await page.goto('/terms')

    await expect(
      page.getByRole('heading', { name: 'Terms of use', level: 1 }),
    ).toBeVisible()
    await expect(page.getByText(/irreversible/i)).toBeVisible()
    await expect(page.getByText(/not a backup/i)).toBeVisible()
  })
})

test.describe('landing footer', () => {
  test('offers both legal pages', async ({ page }) => {
    await page.goto('/')

    await page.getByRole('button', { name: 'Terms' }).click()
    await expect(page).toHaveURL(/\/terms$/)
    await expect(page.getByRole('heading', { name: 'Terms of use' })).toBeVisible()
  })
})

test.describe('rate limiting', () => {
  test('refuses a flood and says when to retry', async ({ playwright }) => {
    const context = await playwright.request.newContext({ ignoreHTTPSErrors: true })

    /*
     * A dedicated probe bucket with an allowance of 3. Flooding the real /auth
     * limit instead would drain a bucket every other test shares, so unrelated
     * tests would start failing depending on execution order.
     */
    await context.post(`${API}/auth/test/reset-rate-limits`)

    const statuses: number[] = []
    for (let i = 0; i < 5; i++) {
      statuses.push((await context.get(`${API}/auth/test/rate-limit-probe`)).status())
    }

    expect(statuses.slice(0, 3)).toEqual([200, 200, 200])
    expect(statuses.slice(3)).toEqual([429, 429])

    const limited = await context.get(`${API}/auth/test/rate-limit-probe`)
    // Without Retry-After the client has no idea how long to wait.
    expect(limited.headers()['retry-after']).toBeTruthy()
    expect(await limited.json()).toMatchObject({
      error: { code: 'too_many_requests' },
    })

    // Leave the bucket clean for whatever runs next.
    await context.post(`${API}/auth/test/reset-rate-limits`)
    await context.dispose()
  })

  test('the real auth and message routes are actually limited', async ({
    playwright,
  }) => {
    const context = await playwright.request.newContext({ ignoreHTTPSErrors: true })

    // Headers prove the middleware is mounted, without draining the bucket.
    for (const path of ['/auth/me', '/messages']) {
      const response = await context.get(`${API}${path}`)
      expect(
        response.headers()['ratelimit-limit'],
        `${path} should be rate limited`,
      ).toBeTruthy()
    }

    await context.dispose()
  })
})

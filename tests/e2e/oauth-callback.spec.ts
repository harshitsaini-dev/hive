import { expect, test, type Page } from '@playwright/test'

/**
 * The page Google redirects back to.
 *
 * This path broke in production and nothing caught it: the earlier design had
 * Google redirect straight to an API route, and the browser does not reliably
 * attach a `SameSite=Lax` session cookie to a cross-site top-level navigation.
 * Locally it worked by accident — the API and the app share a hostname and
 * cookies ignore ports, so the cookie went along anyway.
 *
 * These tests pin the behaviour that replaced it.
 */

interface Calls {
  complete: number
  lastBody: unknown
}

async function stubApi(
  page: Page,
  completeResponse: { status: number; body: unknown },
): Promise<Calls> {
  const calls: Calls = { complete: 0, lastBody: null }

  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ user: { id: 'u1', email: 'tester@example.test' } }),
    }),
  )

  await page.route('**/api/accounts', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ accounts: [] }),
    }),
  )

  await page.route('**/api/accounts/oauth/complete', (route) => {
    calls.complete += 1
    calls.lastBody = route.request().postDataJSON()
    route.fulfill({
      status: completeResponse.status,
      contentType: 'application/json',
      body: JSON.stringify(completeResponse.body),
    })
  })

  return calls
}

const ACCOUNT = {
  id: 'acc-1',
  gmailAddress: 'connected@example.test',
  status: 'active' as const,
  connectedAt: '2026-08-23T00:00:00.000Z',
  lastSyncedAt: null,
}

test.describe('OAuth callback', () => {
  test('redeems the code with a same-origin request', async ({ page }) => {
    const calls = await stubApi(page, {
      status: 200,
      body: { account: ACCOUNT },
    })

    await page.goto('/auth/google/callback?code=the-code&state=the-state')

    // Both in one assertion: the view redirects onwards shortly after
    // succeeding, so checking them one at a time races the navigation.
    await expect(page.getByRole('status')).toContainText('Connected')
    await expect(page.getByRole('status')).toContainText('connected@example.test')

    expect(calls.complete).toBe(1)
    expect(calls.lastBody).toEqual({ code: 'the-code', state: 'the-state' })
  })

  test('never redeems the same code twice', async ({ page }) => {
    // React StrictMode runs effects twice in development, and an
    // authorization code is single-use — a second exchange would fail and
    // replace a good result with an error.
    const calls = await stubApi(page, {
      status: 200,
      body: { account: ACCOUNT },
    })

    await page.goto('/auth/google/callback?code=once-only&state=s')
    await expect(page.getByRole('heading', { name: 'Connected' })).toBeVisible()

    expect(calls.complete).toBe(1)
  })

  test('strips the code out of the address bar', async ({ page }) => {
    await stubApi(page, { status: 200, body: { account: ACCOUNT } })

    await page.goto('/auth/google/callback?code=secret-code&state=s')
    await expect(page.getByRole('heading', { name: 'Connected' })).toBeVisible()

    // Single-use or not, it has no business sitting in history.
    expect(page.url()).not.toContain('secret-code')
    expect(page.url()).not.toContain('code=')
  })

  test('treats a declined consent as cancelled, not broken', async ({ page }) => {
    const calls = await stubApi(page, { status: 200, body: {} })

    await page.goto('/auth/google/callback?error=access_denied')

    await expect(page.getByRole('status')).toContainText(/Connection cancelled/)
    // Nothing to redeem, so nothing should have been sent.
    expect(calls.complete).toBe(0)
  })

  test('shows the server’s reason when the exchange fails', async ({ page }) => {
    await stubApi(page, {
      status: 400,
      body: {
        error: {
          code: 'bad_request',
          message: 'That connection attempt expired. Start it again.',
        },
      },
    })

    await page.goto('/auth/google/callback?code=stale&state=mismatched')

    await expect(page.getByRole('status')).toContainText(/did not finish/)
    // The specific reason, not a generic failure — the user can act on it.
    await expect(page.getByText(/expired\. Start it again/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Back to accounts' })).toBeVisible()
  })

  test('a malformed callback does not call the server', async ({ page }) => {
    const calls = await stubApi(page, { status: 200, body: {} })

    await page.goto('/auth/google/callback')

    await expect(page.getByRole('status')).toContainText(/did not finish/)
    expect(calls.complete).toBe(0)
  })
})

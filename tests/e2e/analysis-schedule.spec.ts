import { expect, test, type Page } from '@playwright/test'

/**
 * The scheduled analysis, in the Rules view.
 *
 * The load-bearing property is what it *cannot* do. A cleanup rule moves mail;
 * this only counts it. An automated irreversible action against a query
 * written weeks ago is the worst failure mode this project has available to
 * it, so the schedule carries no action at all — see ADR 0002.
 */

const ACCOUNTS = [
  {
    id: 'acc-1',
    gmailAddress: 'first@example.test',
    status: 'active' as const,
    connectedAt: '2026-08-01T00:00:00.000Z',
    lastSyncedAt: null,
  },
  {
    id: 'acc-2',
    gmailAddress: 'second@example.test',
    status: 'active' as const,
    connectedAt: '2026-08-02T00:00:00.000Z',
    lastSyncedAt: null,
  },
]

interface Seen {
  saved: Record<string, unknown>[]
}

async function stub(page: Page, schedule: unknown = null): Promise<Seen> {
  const seen: Seen = { saved: [] }

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
      body: JSON.stringify({ accounts: ACCOUNTS }),
    }),
  )
  await page.route('**/api/rules', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ rules: [] }),
    }),
  )

  await page.route('**/api/messages/analytics/schedule', (route) => {
    if (route.request().method() === 'PUT') {
      seen.saved.push(route.request().postDataJSON())
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      })
      return
    }

    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ schedule }),
    })
  })

  return seen
}

async function openRules(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Rules' }).click()
  return page.getByRole('heading', { name: 'Scheduled analysis' })
}

test.describe('scheduled analysis', () => {
  test('offers no way to schedule a deletion', async ({ page }) => {
    await stub(page)
    await expect(await openRules(page)).toBeVisible()

    const card = page.locator('.card', { hasText: 'Scheduled analysis' })

    /*
     * The whole point. If a future change ever adds "and trash what it finds",
     * this is the test that should stop it.
     */
    await expect(card).not.toContainText(/delete/i)
    await expect(card).not.toContainText(/trash/i)
    await expect(card).toContainText(/only counts/i)
  })

  test('saves a cadence, an hour and a depth', async ({ page }) => {
    const seen = await stub(page)
    await expect(await openRules(page)).toBeVisible()

    const card = page.locator('.card', { hasText: 'Scheduled analysis' })

    await card.getByRole('button', { name: 'How often' }).click()
    await card.getByRole('option', { name: 'Every week' }).click()

    await card.getByRole('button', { name: 'How deep' }).click()
    await card.getByRole('option', { name: 'Newest 10,000' }).click()

    await card.getByRole('button', { name: 'Turn on' }).click()
    await expect(page.getByText(/Saved\./)).toBeVisible()

    const saved = seen.saved.at(-1)!
    expect(saved).toMatchObject({
      enabled: true,
      cadence: 'weekly',
      scanLimit: 10_000,
      query: '-in:spam',
    })

    /*
     * The time goes out in UTC minutes, because the server cannot know
     * anyone's timezone and 03:00 in a half-hour zone is 21:30 UTC — storing
     * that as a whole hour walks the schedule backwards every round-trip.
     */
    expect(saved.minuteUtc).toBeGreaterThanOrEqual(0)
    expect(saved.minuteUtc).toBeLessThanOrEqual(1439)
  })

  test('restores an existing schedule and can pause it', async ({ page }) => {
    const seen = await stub(page, {
      enabled: true,
      cadence: 'daily',
      minuteUtc: (() => {
        const local = new Date()
        local.setHours(3, 0, 0, 0)
        return local.getUTCHours() * 60 + local.getUTCMinutes()
      })(),
      accountId: 'acc-2',
      query: '-in:spam',
      scanLimit: 5000,
      filters: {},
      lastRunAt: '2026-08-23 03:00:00',
    })
    await expect(await openRules(page)).toBeVisible()

    const card = page.locator('.card', { hasText: 'Scheduled analysis' })

    // Comes back as the local hour that was chosen, not the stored UTC time.
    await expect(card.getByRole('button', { name: 'At' })).toContainText('03:00')
    await expect(card).toContainText('Last scheduled run')

    await card.getByRole('button', { name: 'Pause' }).click()
    await expect(page.getByText(/paused/i)).toBeVisible()
    expect(seen.saved.at(-1)).toMatchObject({ enabled: false })
  })
})

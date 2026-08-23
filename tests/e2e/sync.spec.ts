import { expect, test, type Page } from '@playwright/test'

/**
 * The local message index, as far as the browser can see it.
 *
 * The index exists because of one asymmetry in the Gmail API: counting is
 * cheap and reading is not. Learning who sent a message costs a request each,
 * so the sender rollup the analysis panel is built on takes about half an
 * hour on a large mailbox — every time it is asked. Indexed once, it is a
 * `GROUP BY`.
 *
 * What is worth protecting here is that a backfill is honest about itself. It
 * can legitimately run for hours, and an account that is a third indexed must
 * not look the same as one that is finished.
 */

const BASE = {
  id: 'acc-1',
  gmailAddress: 'first@example.test',
  status: 'active' as const,
  connectedAt: '2026-08-01T00:00:00.000Z',
  lastSyncedAt: null,
}

interface Seen {
  syncCalls: string[]
  accountsCalls: number
}

async function stub(page: Page, sync: unknown): Promise<Seen> {
  const seen: Seen = { syncCalls: [], accountsCalls: 0 }

  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ user: { id: 'u1', email: 'tester@example.test' } }),
    }),
  )

  await page.route('**/api/accounts', (route) => {
    seen.accountsCalls += 1
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ accounts: [{ ...BASE, sync }] }),
    })
  })

  await page.route('**/api/accounts/*/sync', (route) => {
    seen.syncCalls.push(new URL(route.request().url()).pathname)
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ started: true }),
    })
  })

  await page.route('**/api/messages?**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        messages: [],
        nextPageToken: null,
        accounts: [],
        skipped: [],
      }),
    }),
  )

  return seen
}

async function openAccounts(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Accounts' }).click()
}

test.describe('index progress', () => {
  test('says how far a backfill has got, not just that it is running', async ({
    page,
  }) => {
    await stub(page, {
      indexed: 12_500,
      estimate: 103_412,
      backfilling: true,
      lastSyncedAt: null,
      error: null,
    })
    await openAccounts(page)

    await expect(
      page.getByText('Indexing — 12,500 of about 103,412 so far'),
    ).toBeVisible()
  })

  test('a finished index says so', async ({ page }) => {
    await stub(page, {
      indexed: 103_412,
      estimate: 103_412,
      backfilling: false,
      lastSyncedAt: '2026-08-23 12:00:00',
      error: null,
    })
    await openAccounts(page)

    await expect(page.getByText('Indexed 103,412 messages')).toBeVisible()
    await expect(page.getByText(/Indexing —/)).toBeHidden()
  })

  /*
   * Silence looks identical to "nothing has changed", which is the wrong
   * conclusion to leave someone with about a mailbox that stopped syncing
   * three days ago.
   */
  test('a stalled index says why', async ({ page }) => {
    await stub(page, {
      indexed: 400,
      estimate: 103_412,
      backfilling: true,
      lastSyncedAt: null,
      error: 'Gmail is rate limiting this account.',
    })
    await openAccounts(page)

    await expect(page.getByText(/Indexing stopped: Gmail is rate limiting/)).toBeVisible()
  })

  test('can be nudged along by hand', async ({ page }) => {
    const seen = await stub(page, {
      indexed: 0,
      estimate: null,
      backfilling: true,
      lastSyncedAt: null,
      error: null,
    })
    await openAccounts(page)

    const before = seen.accountsCalls
    await page.getByRole('button', { name: 'Index now' }).click()

    await expect.poll(() => seen.syncCalls).toEqual(['/api/accounts/acc-1/sync'])

    // And the list re-reads itself afterwards, so progress actually moves.
    await expect.poll(() => seen.accountsCalls, { timeout: 8000 }).toBeGreaterThan(
      before,
    )
  })
})

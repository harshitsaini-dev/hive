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
  indexingCalls: unknown[]
  accountsCalls: number
}

async function stub(page: Page, sync: unknown): Promise<Seen> {
  const seen: Seen = { syncCalls: [], indexingCalls: [], accountsCalls: 0 }

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

  await page.route('**/api/rules', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ rules: [] }),
    }),
  )

  await page.route('**/api/accounts/*/indexing', (route) => {
    seen.indexingCalls.push(route.request().postDataJSON())
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ paused: true }),
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

/** Status lives on Accounts; the controls live with the other background work. */
async function openAccounts(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Accounts' }).click()
}

async function openIndexing(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Rules' }).click()
  return page.locator('.card', { hasText: 'Indexing' })
}

test.describe('index progress', () => {
  test('says how far a backfill has got, not just that it is running', async ({
    page,
  }) => {
    await stub(page, {
      indexed: 12_500,
      estimate: 103_412,
      backfilling: true,
      paused: false,
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
      paused: false,
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
      paused: false,
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
      paused: false,
      lastSyncedAt: null,
      error: null,
    })
    const card = await openIndexing(page)

    const before = seen.accountsCalls
    await card.getByRole('button', { name: 'Index now' }).click()

    await expect.poll(() => seen.syncCalls).toEqual(['/api/accounts/acc-1/sync'])
    await expect
      .poll(() => seen.accountsCalls, { timeout: 8000 })
      .toBeGreaterThan(before)
  })

  /*
   * Off is a legitimate choice. Someone who connected a mailbox only to send
   * from it should not pay for a background index supporting a search they
   * will never run.
   */
  test('can be turned off for one mailbox', async ({ page }) => {
    const seen = await stub(page, {
      indexed: 400,
      estimate: 103_412,
      backfilling: true,
      paused: false,
      lastSyncedAt: null,
      error: null,
    })
    const card = await openIndexing(page)

    await card.getByRole('button', { name: 'Pause' }).click()
    await expect.poll(() => seen.indexingCalls).toEqual([{ paused: true }])
  })

  test('a paused mailbox says so and cannot be nudged', async ({ page }) => {
    const seen = await stub(page, {
      indexed: 400,
      estimate: 103_412,
      backfilling: true,
      paused: true,
      lastSyncedAt: null,
      error: null,
    })
    const card = await openIndexing(page)

    await expect(card.getByText('Paused — 400 indexed so far')).toBeVisible()
    await expect(card.getByRole('button', { name: 'Index now' })).toBeDisabled()
    await expect(card.getByRole('button', { name: 'Resume' })).toBeEnabled()
    expect(seen.syncCalls).toEqual([])
  })
})

/*
 * Reported: mail sent through Hive arrived as `harshitsaini.dev` where a name
 * should have been. Hive asks Gmail for the display name on the matching
 * `sendAs` alias, which is the right answer when there is one — and an alias
 * with no name of its own makes Gmail fall back to the local part of the
 * address. There is nothing to infer harder about; the person knows what they
 * want to be called.
 */
test.describe('the name on outgoing mail', () => {
  test('says what recipients will see, and lets it be set', async ({ page }) => {
    const saved: unknown[] = []

    await page.route('**/api/auth/me', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: { id: 'u1', email: 'tester@example.test' },
        }),
      }),
    )

    let displayName: string | null = null
    await page.route('**/api/accounts', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ accounts: [{ ...BASE, displayName }] }),
      }),
    )
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
    await page.route('**/api/accounts/*/display-name', (route) => {
      const body = route.request().postDataJSON() as { displayName: string }
      saved.push(body)
      displayName = body.displayName || null
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ displayName }),
      })
    })

    await openAccounts(page)

    // Before: no promise is made beyond "whatever Gmail has".
    await expect(
      page.getByText('Sends under the name set in Gmail for this address'),
    ).toBeVisible()

    await page.getByRole('button', { name: 'Set name' }).click()
    await page.getByLabel('Display name').fill('Harshit')
    await page.getByRole('button', { name: 'Save' }).click()

    expect(saved).toEqual([{ displayName: 'Harshit' }])
    await expect(
      page.getByText('Sends as Harshit <first@example.test>'),
    ).toBeVisible()
  })
})

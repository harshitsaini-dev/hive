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
  reindexCalls: string[]
  indexingCalls: unknown[]
  accountsCalls: number
}

async function stub(page: Page, sync: unknown): Promise<Seen> {
  const seen: Seen = {
    syncCalls: [],
    reindexCalls: [],
    indexingCalls: [],
    accountsCalls: 0,
  }

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

  await page.route('**/api/accounts/*/reindex', (route) => {
    seen.reindexCalls.push(new URL(route.request().url()).pathname)
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ started: true }),
    })
  })

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
      nextRunAt: new Date(Date.now() + 6 * 60_000).toISOString(),
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
 * should have been.
 *
 * Nothing here is configurable, deliberately. Hive works the name out — from
 * Google's own record of who owns the mailbox, from Gmail's `sendAs` alias,
 * or from the `From` header of mail the account has already sent. Asking the
 * user to type their own name in would be setup for something that should
 * simply work.
 */
test.describe('the name on outgoing mail', () => {
  async function stubAccounts(page: Page, senderName: string | null) {
    await page.route('**/api/auth/me', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: { id: 'u1', email: 'tester@example.test' },
        }),
      }),
    )
    await page.route('**/api/accounts', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ accounts: [{ ...BASE, senderName }] }),
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
  }

  test('states the name recipients will see', async ({ page }) => {
    await stubAccounts(page, 'Harshit')
    await openAccounts(page)

    await expect(
      page.getByText('Sends as Harshit <first@example.test>'),
    ).toBeVisible()
  })

  /*
   * And when nothing could be worked out, it says the bare address rather
   * than implying a name is there. Gmail will show the local part; the page
   * should not pretend otherwise.
   */
  test('says the bare address when no name is known', async ({ page }) => {
    await stubAccounts(page, null)
    await openAccounts(page)

    await expect(page.getByText('Sends as first@example.test')).toBeVisible()
    await expect(page.getByRole('button', { name: /name/i })).toBeHidden()
  })
})

/*
 * Reported: "indexing auto nahi hoti hai" — it did, hourly, which on a
 * multi-thousand-message backfill is indistinguishable from stopped. Work
 * that happens on its own has to say so, or "Index now" becomes a habit
 * rather than a nudge.
 */
test.describe('the next check is visible', () => {
  test('says when it will look again, without being asked', async ({ page }) => {
    await stub(page, {
      indexed: 400,
      estimate: 103_412,
      backfilling: true,
      paused: false,
      lastSyncedAt: null,
      nextRunAt: new Date(Date.now() + 4 * 60_000).toISOString(),
      error: null,
    })
    const card = await openIndexing(page)

    await expect(card.getByText(/Next check in 4 minutes/)).toBeVisible()
  })

  /*
   * A rate limit is the case where this matters most: it is exactly when
   * someone would otherwise sit pressing the button.
   */
  test('a rate-limited account says it will try again by itself', async ({
    page,
  }) => {
    await stub(page, {
      indexed: 400,
      estimate: 103_412,
      backfilling: true,
      paused: false,
      lastSyncedAt: null,
      nextRunAt: new Date(Date.now() + 7 * 60_000).toISOString(),
      error: 'Gmail is rate limiting this account.',
    })
    const card = await openIndexing(page)

    await expect(card.getByText(/it will try again then/)).toBeVisible()
  })

  test('a paused account promises nothing', async ({ page }) => {
    await stub(page, {
      indexed: 400,
      estimate: 103_412,
      backfilling: true,
      paused: true,
      lastSyncedAt: null,
      nextRunAt: null,
      error: null,
    })
    const card = await openIndexing(page)

    await expect(card.getByText(/Next check/)).toBeHidden()
  })
})

/*
 * Reported: "Indexing — 26,829 of about 501 so far".
 *
 * `messages.list` returns a `resultSizeEstimate` that is not one — on a
 * mailbox of tens of thousands it came back as the page size plus one. The
 * real total now comes from the profile, and a figure below what is already
 * indexed is not shown at all: one obviously wrong number destroys confidence
 * in the two beside it.
 */
test('an estimate smaller than the count is not shown', async ({ page }) => {
  await stub(page, {
    indexed: 26_829,
    estimate: 501,
    backfilling: true,
    paused: false,
    lastSyncedAt: null,
    nextRunAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    error: null,
  })
  const card = await openIndexing(page)

  await expect(card.getByText('Indexing — 26,829 so far')).toBeVisible()
  await expect(card.getByText(/of about/)).toBeHidden()
})

/*
 * Reported: an account showing 21,538 indexed for a mailbox whose inbox and
 * trash had both been emptied — and pressing "Index now" repeatedly changed
 * nothing.
 *
 * It could not. A backfill only adds, and an incremental pass only applies
 * what `history.list` reports since its cursor; anything deleted while the
 * first pass was still running, or after the cursor lapsed, is invisible to
 * both. The server reconciles against Gmail's own id list every few hours to
 * catch exactly that; Rebuild is the way to do it now rather than wait.
 */
test.describe('an index that has drifted', () => {
  /*
   * Rebuild is a different request from "Index now", and the difference is
   * the entire point — one advances the index, only the other can drop what
   * is no longer there.
   */
  test('rebuilding is confirmed first, and is not a sync', async ({ page }) => {
    const seen = await stub(page, {
      indexed: 21_538,
      estimate: 2_100,
      backfilling: false,
      paused: false,
      lastSyncedAt: '2026-08-24 12:00:00',
      nextRunAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      error: null,
    })
    const card = await openIndexing(page)

    await card.getByRole('button', { name: 'Rebuild' }).click()

    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toContainText('Nothing in Gmail changes')
    await dialog.getByRole('button', { name: 'Rebuild index' }).click()

    await expect.poll(() => seen.reindexCalls).toEqual([
      '/api/accounts/acc-1/reindex',
    ])
    expect(seen.syncCalls).toEqual([])
  })

  test('a cancelled rebuild touches nothing', async ({ page }) => {
    const seen = await stub(page, {
      indexed: 21_538,
      estimate: 2_100,
      backfilling: false,
      paused: false,
      lastSyncedAt: '2026-08-24 12:00:00',
      nextRunAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      error: null,
    })
    const card = await openIndexing(page)

    await card.getByRole('button', { name: 'Rebuild' }).click()
    await page.getByRole('button', { name: 'Cancel' }).click()

    await expect(page.getByRole('alertdialog')).toBeHidden()
    expect(seen.reindexCalls).toEqual([])
  })
})

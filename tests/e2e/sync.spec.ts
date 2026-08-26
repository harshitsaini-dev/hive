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

    /*
     * Hive's count, and only Hive's. Gmail's `messagesTotal` used to sit
     * beside it and lags badly after a bulk deletion — a mailbox emptied to a
     * few thousand kept reporting a hundred thousand — so the pair read as
     * though the index still held all of them. It drives the bar and is not
     * printed.
     */
    await expect(page.getByText('Indexed 12,500 so far')).toBeVisible()
    await expect(page.getByText(/103,412/)).toBeHidden()
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

  await expect(card.getByText('Indexed 26,829 so far')).toBeVisible()
  await expect(card.getByText(/Gmail reports/)).toBeHidden()
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

/*
 * The Rules page carries two cards, and both had gone wrong in ways that only
 * showed up with real data: the index draws a row per connected mailbox, and
 * nineteen of those pushed the thing the page is named after off the bottom
 * of the screen — while the two cards sat at visibly different widths for no
 * reason a reader could see.
 */
test.describe('the rules page layout', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  async function manyAccounts(page: Page) {
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
        body: JSON.stringify({
          accounts: Array.from({ length: 19 }, (_, n) => ({
            id: `a${n}`,
            gmailAddress: `mailbox.${n}@example.test`,
            status: 'active',
            connectedAt: '2026-08-01T00:00:00.000Z',
            lastSyncedAt: null,
            sync: {
              indexed: 1520,
              estimate: 2000,
              backfilling: false,
              paused: false,
              lastSyncedAt: null,
              nextRunAt: new Date(Date.now() + 60_000).toISOString(),
              error: null,
            },
          })),
        }),
      }),
    )
    await page.route('**/api/rules', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ rules: [] }),
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

  test('rules come before the index, at the same width', async ({ page }) => {
    await manyAccounts(page)
    await page.goto('/')
    await page.getByRole('button', { name: 'Rules' }).click()
    await page.waitForSelector('.indexing')

    const rules = (await page.locator('.rules').boundingBox())!
    const index = (await page.locator('.indexing').boundingBox())!
    const cards = page.locator('.app__main .card')

    // The short card, and the reason anyone came here, is on top.
    expect(rules.y).toBeLessThan(index.y)

    // Two cards, one width. It was 672 against 832, because the index card
    // was sized by its own widest row rather than by the page.
    const widths = await cards.evaluateAll((els) =>
      els.map((el) => Math.round(el.getBoundingClientRect().width)),
    )
    expect(new Set(widths).size).toBe(1)
    expect(widths[0]).toBeGreaterThan(832)
  })
})

/*
 * Forty-one connected mailboxes. Both lists are alphabet soup at that size,
 * and reaching one meant scrolling past forty.
 */
test.describe('finding one mailbox among many', () => {
  async function manyAccounts(page: Page, count: number) {
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
        body: JSON.stringify({
          accounts: Array.from({ length: count }, (_, n) => ({
            id: `a${n}`,
            gmailAddress:
              n === 7 ? 'rajmandir.nangloi@example.test' : `mailbox.${n}@example.test`,
            status: 'active',
            connectedAt: '2026-08-01T00:00:00.000Z',
            lastSyncedAt: null,
            senderName: null,
            sync: {
              indexed: 100 + n,
              estimate: 200,
              backfilling: false,
              paused: false,
              lastSyncedAt: null,
              nextRunAt: new Date(Date.now() + 60_000).toISOString(),
              error: null,
            },
          })),
        }),
      }),
    )
    await page.route('**/api/rules', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ rules: [] }),
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

  test('the indexing card can be searched', async ({ page }) => {
    await manyAccounts(page, 41)
    await page.goto('/')
    await page.getByRole('button', { name: 'Rules' }).click()

    const card = page.locator('.card', { hasText: 'Indexing' })
    await expect(card.locator('.indexing li')).toHaveCount(41)

    await card.getByPlaceholder('Find a mailbox').fill('nangloi')
    await expect(card.locator('.indexing li')).toHaveCount(1)
    await expect(card.getByText('rajmandir.nangloi@example.test')).toBeVisible()

    // And says so rather than showing an empty box.
    await card.getByPlaceholder('Find a mailbox').fill('nothing-like-this')
    await expect(card.getByText(/No mailbox matches/)).toBeVisible()
  })

  test('the accounts page can be searched', async ({ page }) => {
    await manyAccounts(page, 41)
    await page.goto('/')
    await page.getByRole('button', { name: 'Accounts' }).click()

    await expect(page.locator('.accounts li')).toHaveCount(41)

    await page.getByPlaceholder('Find a mailbox').fill('nangloi')
    await expect(page.locator('.accounts li')).toHaveCount(1)
  })

  /*
   * It rendered as a 256px-tall box with the input floating in the middle.
   * `.search-field` carries `flex: 1 1 16rem`, written for the filter row
   * where 16rem is a *width* — and both of these sit in a flex column, where
   * the same value is read as a height.
   */
  test('the search box is a row, not a panel', async ({ page }) => {
    await manyAccounts(page, 41)
    await page.goto('/')

    for (const [destination, selector] of [
      ['Rules', '.indexing__find'],
      ['Accounts', '.accounts__find'],
    ] as const) {
      await page.getByRole('button', { name: destination }).click()
      const box = (await page.locator(selector).boundingBox())!

      expect(box.height).toBeLessThan(60)
      // And it spans the card rather than sitting in a corner of it.
      expect(box.width).toBeGreaterThan(400)
    }
  })

  /*
   * A search box above four rows is furniture. It appears when the list is
   * long enough to need one.
   */
  test('a short list has no search box', async ({ page }) => {
    await manyAccounts(page, 3)
    await page.goto('/')
    await page.getByRole('button', { name: 'Accounts' }).click()

    await expect(page.locator('.accounts li')).toHaveCount(3)
    await expect(page.getByPlaceholder('Find a mailbox')).toBeHidden()
  })
})

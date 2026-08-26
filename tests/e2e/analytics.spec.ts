import { expect, test, type Locator, type Page } from '@playwright/test'

/**
 * The mailbox analysis panel.
 *
 * The thing worth protecting here is honesty about scope. Two of its numbers
 * are exact for the whole mailbox because they come from lists of message
 * ids; the sender breakdown reads a header per message and therefore covers
 * only the newest slice. A panel that showed both the same way would be
 * describing a fraction of the mailbox while looking like it described all of
 * it — so the depth it actually reached is stated, every time.
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

const ANALYSIS = {
  total: 103_412,
  withAttachment: 21_003,
  withoutAttachment: 82_409,
  scanned: 5_000,
  truncated: true,
  accounts: [
    {
      accountId: 'acc-1',
      gmailAddress: 'first@example.test',
      count: 100_000,
      withAttachment: 20_000,
    },
    {
      accountId: 'acc-2',
      gmailAddress: 'second@example.test',
      count: 3_412,
      withAttachment: 1_003,
    },
  ],
  senders: [
    {
      address: 'kapil@example.test',
      name: 'Kapil Gupta',
      count: 812,
      withAttachment: 96,
      byAccount: {
        'acc-1': { count: 800, withAttachment: 90 },
        'acc-2': { count: 12, withAttachment: 6 },
      },
    },
    {
      address: 'noreply@shop.test',
      name: 'Shop',
      count: 240,
      withAttachment: 0,
      byAccount: { 'acc-1': { count: 240, withAttachment: 0 } },
    },
  ],
}

interface Seen {
  searchQueries: string[]
  analyseBodies: Record<string, unknown>[]
  resolveBodies: Record<string, unknown>[]
  trashBodies: Record<string, unknown>[]
}

async function stub(page: Page, analysis = ANALYSIS): Promise<Seen> {
  const seen: Seen = {
    searchQueries: [],
    analyseBodies: [],
    resolveBodies: [],
    trashBodies: [],
  }

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

  await page.route('**/api/messages?**', (route) => {
    seen.searchQueries.push(
      new URL(route.request().url()).searchParams.get('q') ?? '',
    )
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        messages: [],
        nextPageToken: null,
        accounts: ACCOUNTS.map((account) => ({
          accountId: account.id,
          gmailAddress: account.gmailAddress,
          error: null,
        })),
        skipped: [],
      }),
    })
  })

  /*
   * The saved run lives on the server, so it is there from any device. The
   * stub starts empty and remembers what was analysed, exactly as the real
   * endpoint does.
   */
  await page.route('**/api/messages/analytics/last', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        activeJobId: null,
        run: seen.analyseBodies.length
          ? {
              accountId: null,
              query: 'in:inbox',
              filters: {},
              result: analysis,
              finishedAt: '2026-08-23 12:26:00',
            }
          : null,
      }),
    }),
  )

  await page.route('**/api/messages/analytics', (route) => {
    seen.analyseBodies.push(route.request().postDataJSON())
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jobId: 'job-1' }),
    })
  })

  await page.route('**/api/messages/jobs/job-1', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'job-1',
        action: 'analyze',
        total: 5000,
        processed: 5000,
        status: 'done',
        error: null,
        result: analysis,
      }),
    }),
  )

  await page.route('**/api/messages/resolve-query', (route) => {
    seen.resolveBodies.push(route.request().postDataJSON())
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        messageIds: ['x1', 'x2', 'x3'],
        count: 3,
        truncated: false,
        limit: 10_000,
      }),
    })
  })

  await page.route('**/api/messages/trash', (route) => {
    seen.trashBodies.push(route.request().postDataJSON())
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ trashed: 3 }),
    })
  })

  return seen
}

async function openPanel(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Analyse mailbox' }).click()

  // Scoped, because the filter panel behind it has its own Age dropdown.
  return page.getByRole('complementary', { name: 'Mailbox analysis' })
}

/** The sender rows, which share their View/Clear labels with the stat cards. */
function senderRows(panel: ReturnType<Page['getByRole']>) {
  return panel.locator('.analytics__senders')
}

test.describe('mailbox analysis', () => {
  test('reports the split between mail with and without attachments', async ({
    page,
  }) => {
    await stub(page)
    const panel = await openPanel(page)
    await panel.getByRole('button', { name: 'Analyse', exact: true }).click()

    const cards = panel.locator('.analytics__stat')
    await expect(cards.nth(0)).toContainText('103,412')
    await expect(cards.nth(1)).toContainText('21,003')
    await expect(cards.nth(2)).toContainText('82,409')

    // The percentage is stated, not left to be worked out from two numbers.
    await expect(panel.getByText('with attachments (20%)')).toBeVisible()
  })

  test('ranks senders and says how deep the scan actually went', async ({
    page,
  }) => {
    await stub(page)
    const panel = await openPanel(page)
    await panel.getByRole('button', { name: 'Analyse', exact: true }).click()

    await expect(panel.getByText('Kapil Gupta')).toBeVisible()
    // The row carries both numbers: how many, and how many of those had files.
    const busiest = panel.locator('.analytics__senders li').first()
    await expect(busiest).toContainText('812')
    await expect(busiest).toContainText('96')

    /*
     * The load-bearing assertion. A sender list built from the newest 5,000
     * of 103,412 must never be presented as the whole mailbox.
     */
    await expect(panel.getByText('from the newest 5,000 of 103,412')).toBeVisible()
    await expect(panel.getByText(/covers the newest 5,000/)).toBeVisible()
  })

  test('a complete scan does not warn about depth', async ({ page }) => {
    await stub(page, {
      ...ANALYSIS,
      total: 300,
      withAttachment: 40,
      withoutAttachment: 260,
      scanned: 300,
      truncated: false,
    })
    const panel = await openPanel(page)
    await panel.getByRole('button', { name: 'Analyse', exact: true }).click()

    await expect(panel.getByText('Kapil Gupta')).toBeVisible()
    await expect(panel.getByText(/covers the newest/)).toBeHidden()
  })

  test('carries the account and date filters into the run', async ({ page }) => {
    const seen = await stub(page)
    const panel = await openPanel(page)

    await panel.getByRole('button', { name: 'Accounts to analyse' }).click()
    const picker = page.getByRole('dialog', { name: 'Accounts to analyse' })
    await picker.getByPlaceholder('Find a mailbox').fill('second@')
    await picker.getByRole('checkbox').check()
    await page.keyboard.press('Escape')

    await panel.getByRole('button', { name: 'Age', exact: true }).click()
    await panel.getByRole('option', { name: 'Older than a year' }).click()

    await panel.getByRole('button', { name: 'Analyse', exact: true }).click()
    await expect(panel.locator('.analytics__stat').first()).toContainText(
      '103,412',
    )

    expect(seen.analyseBodies.at(-1)).toMatchObject({
      // A list now — several mailboxes can be analysed as one.
      accountIds: ['acc-2'],
      query: 'in:inbox older_than:1y',
      scanLimit: 5000,
    })
  })

  /*
   * Trash, never permanent delete. A chart is a place to notice something,
   * not a place to destroy mail from — anything cleared here has to stay
   * recoverable, and permanent deletion stays behind the typed confirmation
   * in the Trash view.
   */
  test('clearing a sender trashes their mail and never deletes it', async ({
    page,
  }) => {
    const seen = await stub(page)
    let deleteForeverCalled = false
    await page.route('**/api/messages/delete-forever', (route) => {
      deleteForeverCalled = true
      route.fulfill({ status: 200, body: '{}' })
    })

    const panel = await openPanel(page)
    await panel.getByRole('button', { name: 'Analyse', exact: true }).click()
    await expect(panel.getByText('Kapil Gupta')).toBeVisible()

    await senderRows(panel).getByRole('button', { name: 'Clear' }).first().click()

    /*
     * The app's own dialog, not `window.confirm` — which titled itself with
     * the domain name, in the operating system's colours, in the middle of a
     * themed app, and blocked the page thread while it was up.
     */
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toContainText('kapil@example.test')
    await dialog.getByRole('button', { name: 'Move to Trash' }).click()

    await expect(page.getByText(/Moved 6 messages/)).toBeVisible()

    // Scoped to that sender, and excluding what is already binned.
    expect(seen.resolveBodies.at(-1)).toMatchObject({
      query: 'in:inbox from:kapil@example.test -in:trash',
    })
    expect(seen.trashBodies).toHaveLength(2)
    expect(deleteForeverCalled).toBe(false)
  })

  test('a cancelled confirmation touches nothing', async ({ page }) => {
    const seen = await stub(page)

    const panel = await openPanel(page)
    await panel.getByRole('button', { name: 'Analyse', exact: true }).click()
    await expect(panel.getByText('Kapil Gupta')).toBeVisible()

    await senderRows(panel).getByRole('button', { name: 'Clear' }).first().click()
    await page.getByRole('button', { name: 'Cancel' }).click()

    await expect(page.getByRole('alertdialog')).toBeHidden()
    await expect(panel.getByText('Kapil Gupta')).toBeVisible()
    expect(seen.trashBodies).toHaveLength(0)
  })
})

/*
 * Clearing 812 messages on the strength of a number alone is a leap — an
 * address you half-recognise could be receipts. Looking has to be reachable
 * without throwing away an analysis that took minutes.
 */
test('viewing a sender fills the list without closing the analysis', async ({
  page,
}) => {
  const seen = await stub(page)
  const panel = await openPanel(page)
  await panel.getByRole('button', { name: 'Analyse', exact: true }).click()
  await expect(panel.getByText('Kapil Gupta')).toBeVisible()

  await senderRows(panel).getByRole('button', { name: 'View' }).first().click()

  // The list beside it now searches for that sender, across all mail.
  await expect
    .poll(() => decodeURIComponent(seen.searchQueries.at(-1) ?? ''))
    .toBe('-in:spam from:kapil@example.test')

  // And the analysis is still there to act on.
  await expect(panel.getByText('Kapil Gupta')).toBeVisible()
})

test.describe('a finished run is kept', () => {
  test('survives a reload without running again', async ({ page }) => {
    const seen = await stub(page)
    const panel = await openPanel(page)
    await panel.getByRole('button', { name: 'Analyse', exact: true }).click()
    await expect(panel.getByText('Kapil Gupta')).toBeVisible()
    expect(seen.analyseBodies).toHaveLength(1)

    await page.reload()
    const again = page.getByRole('complementary', { name: 'Mailbox analysis' })
    await page.getByRole('button', { name: 'Analyse mailbox' }).click()

    await expect(again.getByText('Kapil Gupta')).toBeVisible()
    await expect(again.getByText(/Last run/)).toBeVisible()

    // The whole point: no second run, so no second slice of Gmail quota.
    expect(seen.analyseBodies).toHaveLength(1)
  })

  /*
   * Clearing builds its query from the controls, so acting on numbers
   * produced under different filters would trash a different set of mail than
   * the figure on screen says.
   */
  test('withholds Clear once the filters have moved on', async ({ page }) => {
    await stub(page)
    const panel = await openPanel(page)
    await panel.getByRole('button', { name: 'Analyse', exact: true }).click()
    await expect(panel.getByText('Kapil Gupta')).toBeVisible()
    await expect(
      senderRows(panel).getByRole('button', { name: 'Clear' }).first(),
    ).toBeEnabled()

    await panel.getByRole('button', { name: 'Age', exact: true }).click()
    await panel.getByRole('option', { name: 'Older than a year' }).click()

    await expect(panel.getByText(/Filters have changed/)).toBeVisible()
    await expect(
      senderRows(panel).getByRole('button', { name: 'Clear' }).first(),
    ).toBeDisabled()

    // Looking is still fine — it is reading, not destroying.
    await expect(
      senderRows(panel).getByRole('button', { name: 'View' }).first(),
    ).toBeEnabled()
  })
})

/*
 * Junk arrives in clumps, which is the reason to rank senders at all.
 * Clearing eleven newsletters one confirmation at a time is eleven chances to
 * misclick and a lot of waiting.
 */
test.describe('acting on several senders at once', () => {
  test('views a selection as one query', async ({ page }) => {
    const seen = await stub(page)
    const panel = await openPanel(page)
    await panel.getByRole('button', { name: 'Analyse', exact: true }).click()
    await expect(panel.getByText('Kapil Gupta')).toBeVisible()

    await panel.getByLabel('Select kapil@example.test').check()
    await panel.getByLabel('Select noreply@shop.test').check()
    await expect(panel.getByText('2 selected · 1,052 messages')).toBeVisible()

    await panel
      .locator('.analytics__selectbar')
      .getByRole('button', { name: 'View' })
      .click()

    // One Gmail query, not one per sender — one page of results to read.
    await expect
      .poll(() => decodeURIComponent(seen.searchQueries.at(-1) ?? ''))
      .toBe('-in:spam from:(kapil@example.test OR noreply@shop.test)')
  })

  test('clears a selection behind one confirmation', async ({ page }) => {
    const seen = await stub(page)
    const panel = await openPanel(page)
    await panel.getByRole('button', { name: 'Analyse', exact: true }).click()
    await expect(panel.getByText('Kapil Gupta')).toBeVisible()

    await panel.getByLabel('Select all').check()
    await panel
      .locator('.analytics__selectbar')
      .getByRole('button', { name: 'Clear' })
      .click()

    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toContainText('2 senders')
    await dialog.getByRole('button', { name: 'Move to Trash' }).click()

    await expect(page.getByText(/Moved 12 messages from 2 senders/)).toBeVisible()

    /*
     * One sender per request rather than a single combined query: a partial
     * failure then leaves a known state instead of one opaque failure
     * covering all of them.
     */
    expect(seen.resolveBodies.map((body) => body.query)).toEqual([
      'in:inbox from:kapil@example.test -in:trash',
      'in:inbox from:kapil@example.test -in:trash',
      'in:inbox from:noreply@shop.test -in:trash',
      'in:inbox from:noreply@shop.test -in:trash',
    ])

    // Both rows are gone, and nothing stays ticked.
    await expect(panel.getByText('Kapil Gupta')).toBeHidden()
    await expect(panel.getByText('2 selected')).toBeHidden()
  })
})

/*
 * The three totals are the filter. Switching between them costs nothing: a
 * sender's total and its attachment count already imply the third figure, so
 * it is arithmetic on a run that has happened rather than another few minutes
 * of Gmail quota.
 */
test.describe('the totals narrow the panel', () => {
  test('recounts the senders for each of the three views', async ({ page }) => {
    await stub(page)
    const panel = await openPanel(page)
    await panel.getByRole('button', { name: 'Analyse', exact: true }).click()

    const busiest = panel.locator('.analytics__senders li').first()
    await expect(busiest).toContainText('812')

    // 96 of Kapil's 812 carried a file, so "with" shows 96 — and the shop,
    // which sent none, drops out of the list entirely rather than showing 0.
    await panel.getByRole('button', { name: /with attachments/ }).click()
    await expect(busiest).toContainText('96')
    await expect(panel.getByText('noreply@shop.test')).toBeHidden()

    // And the remainder is the other 716.
    await panel.getByRole('button', { name: 'without', exact: false }).click()
    await expect(busiest).toContainText('716')
    await expect(panel.getByText('noreply@shop.test')).toBeVisible()
  })

  test('the pressed total scopes what Clear acts on', async ({ page }) => {
    const seen = await stub(page)
    const panel = await openPanel(page)
    await panel.getByRole('button', { name: 'Analyse', exact: true }).click()

    await panel.getByRole('button', { name: /with attachments/ }).click()
    await senderRows(panel).getByRole('button', { name: 'Clear' }).first().click()

    const dialog = page.getByRole('alertdialog')
    await dialog.getByRole('button', { name: 'Move to Trash' }).click()
    await expect(page.getByText(/Moved 6 messages/)).toBeVisible()

    // Looking, too: View from this state must not show mail the number excludes.
    await senderRows(panel).getByRole('button', { name: 'View' }).first().click()
    await expect
      .poll(() => decodeURIComponent(seen.searchQueries.at(-1) ?? ''))
      .toBe('-in:spam from:kapil@example.test has:attachment')

    /*
     * `has:attachment` is in the query. Clearing from the attachments view
     * must not take the sender's attachment-free mail with it — the number
     * shown said 96, so 96 is what may move.
     */
    expect(seen.resolveBodies.at(-1)).toMatchObject({
      query: 'in:inbox has:attachment from:kapil@example.test -in:trash',
    })
  })
})

/*
 * A scan can take half an hour. Making someone sit and watch it — or lose it
 * by closing the tab — would make the deep options unusable, which are
 * exactly the ones a large mailbox needs.
 */
test.describe('runs that outlive the page', () => {
  test('reattaches to a run left going in the background', async ({ page }) => {
    let polls = 0

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
        body: JSON.stringify({ accounts: ACCOUNTS }),
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

    // Nothing stored yet, but a job is running — the state after closing the
    // tab a minute into a scan.
    await page.route('**/api/messages/analytics/last', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ run: null, activeJobId: 'job-9' }),
      }),
    )

    let started = false
    await page.route('**/api/messages/analytics', (route) => {
      started = true
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jobId: 'job-9' }),
      })
    })

    await page.route('**/api/messages/jobs/job-9', (route) => {
      polls += 1
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'job-9',
          action: 'analyze',
          total: 5000,
          processed: polls < 2 ? 1200 : 5000,
          status: polls < 2 ? 'running' : 'done',
          error: null,
          result: polls < 2 ? null : ANALYSIS,
        }),
      })
    })

    const panel = await openPanel(page)

    await expect(panel.getByText(/you can close this and come back/)).toBeVisible()
    await expect(panel.getByText('Kapil Gupta')).toBeVisible()

    // It followed the existing job instead of paying for the work twice.
    expect(started).toBe(false)
  })

  test('a re-run keeps the previous numbers on screen', async ({ page }) => {
    const seen = await stub(page)
    const panel = await openPanel(page)
    await panel.getByRole('button', { name: 'Analyse', exact: true }).click()
    await expect(panel.getByText('Kapil Gupta')).toBeVisible()

    // Hold the second run open so the in-between state is observable.
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route('**/api/messages/jobs/job-1', async (route) => {
      await held
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'job-1',
          action: 'analyze',
          total: 5000,
          processed: 5000,
          status: 'done',
          error: null,
          result: ANALYSIS,
        }),
      })
    })

    await panel.getByRole('button', { name: 'Run again' }).click()

    /*
     * Blanking the panel made "Run again" feel like it had destroyed the
     * answer — and during the minutes a scan takes, the old numbers are still
     * the best ones there are.
     */
    await expect(panel.getByText(/Refreshing — showing the last run/)).toBeVisible()
    await expect(panel.getByText('Kapil Gupta')).toBeVisible()
    await expect(panel.locator('.analytics__stat').first()).toContainText(
      '103,412',
    )

    release()
    await expect(panel.getByText('Kapil Gupta')).toBeVisible()
    expect(seen.analyseBodies).toHaveLength(2)
  })
})

/*
 * Same trick as the attachment split: the run already recorded who sent what
 * in which mailbox, so narrowing to one account is arithmetic on work already
 * paid for rather than another scan.
 */
/*
 * The mailbox narrowing is a picker rather than a row of chips: at forty-one
 * connected accounts the chips wrapped over eight lines and pushed the sender
 * list, which is what the panel is for, below the fold.
 */
async function narrowTo(page: Page, panel: Locator, address: string) {
  await panel.getByRole('button', { name: 'Mailboxes shown' }).click()
  const picker = page.getByRole('dialog', { name: 'Mailboxes shown' })
  await picker.getByPlaceholder('Find a mailbox').fill(address)
  await picker.getByRole('checkbox').check()
  await page.keyboard.press('Escape')
}

/*
 * The picker replaced a row of chips, and inherited the two things the chips
 * had already been taught: a count that reads against its own background, and
 * a total that agrees with the headline it sits under.
 */
test.describe('the mailbox picker states its numbers honestly', () => {
  test('the all-mailboxes figure is the headline total, not a sum', async ({
    page,
  }) => {
    // A mailbox the run did not break out — so the parts total less than the
    // whole, which is the case a sum would quietly get wrong.
    await stub(page, { ...ANALYSIS, total: 120_000 })
    const panel = await openPanel(page)
    await panel.getByRole('button', { name: 'Analyse', exact: true }).click()

    await panel.getByRole('button', { name: 'Mailboxes shown' }).click()
    const all = page
      .getByRole('dialog', { name: 'Mailboxes shown' })
      .getByRole('button', { name: /All accounts/ })

    await expect(all).toContainText('120,000')
    await expect(all).not.toContainText('103,412')
  })

  test('the count reads against the row it sits on', async ({ page }) => {
    await stub(page)
    const panel = await openPanel(page)
    await panel.getByRole('button', { name: 'Analyse', exact: true }).click()
    await panel.getByRole('button', { name: 'Mailboxes shown' }).click()

    /*
     * `.hint` is muted grey, which on the accent fill of the chosen row is
     * close to invisible — the count has to borrow the row's own colour. The
     * chips carried this fix; the picker had to be told again.
     */
    const colours = await page
      .getByRole('dialog', { name: 'Mailboxes shown' })
      .getByRole('button', { name: /All accounts/ })
      .evaluate((el) => ({
        row: getComputedStyle(el).color,
        count: getComputedStyle(el.querySelector('.hint')!).color,
      }))

    expect(colours.count).toBe(colours.row)
  })
})

test.describe('narrowing to one mailbox', () => {
  test('recounts the totals and the senders for that account', async ({
    page,
  }) => {
    await stub(page)
    const panel = await openPanel(page)
    await panel.getByRole('button', { name: 'Analyse', exact: true }).click()

    const cards = panel.locator('.analytics__stat')
    await expect(cards.nth(0)).toContainText('103,412')

    await narrowTo(page, panel, 'second@example.test')

    await expect(cards.nth(0)).toContainText('3,412')
    await expect(cards.nth(1)).toContainText('1,003')

    // Kapil sent 12 of his 812 into this mailbox; the shop sent none, so it
    // leaves the list rather than sitting there as a zero.
    await expect(panel.locator('.analytics__senders li').first()).toContainText(
      '12',
    )
    await expect(panel.getByText('noreply@shop.test')).toBeHidden()
  })

  test('the chosen mailbox scopes what Clear acts on', async ({ page }) => {
    const seen = await stub(page)
    const panel = await openPanel(page)
    await panel.getByRole('button', { name: 'Analyse', exact: true }).click()
    await narrowTo(page, panel, 'second@example.test')

    await senderRows(panel).getByRole('button', { name: 'Clear' }).first().click()
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Move to Trash' })
      .click()

    /*
     * One account, not both. A figure of 12 that belongs to one mailbox must
     * not clear 812 across all of them — the number on screen is the promise
     * being kept.
     */
    await expect(page.getByText(/Moved 3 messages/)).toBeVisible()
    expect(seen.resolveBodies).toHaveLength(1)
    expect(seen.resolveBodies.at(-1)).toMatchObject({ accountId: 'acc-2' })
  })
})

/*
 * Reported: the inbox said 8,361 and the analysis beside it said 10,605, with
 * nothing on screen to explain the gap. Neither number was wrong — one was
 * `in:inbox`, the other the whole mailbox — but two totals disagreeing side by
 * side is a bug regardless of which is correct.
 */
test.describe('the analysis follows the list it sits beside', () => {
  test('measures the folder on screen, and says which', async ({ page }) => {
    const seen = await stub(page)
    const panel = await openPanel(page)

    await expect(panel.getByText('Measuring Inbox')).toBeVisible()
    await panel.getByRole('button', { name: 'Analyse', exact: true }).click()

    expect(seen.analyseBodies.at(-1)).toMatchObject({ query: 'in:inbox' })
  })

  test('follows the nav to another folder', async ({ page }) => {
    const seen = await stub(page)
    await page.goto('/')
    await page.getByRole('button', { name: 'Sent', exact: true }).click()
    await page.getByRole('button', { name: 'Analyse mailbox' }).click()

    const panel = page.getByRole('complementary', { name: 'Mailbox analysis' })
    await expect(panel.getByText('Measuring Sent')).toBeVisible()

    await panel.getByRole('button', { name: 'Analyse', exact: true }).click()
    expect(seen.analyseBodies.at(-1)).toMatchObject({ query: 'in:sent' })
  })

  test('can still be widened to the whole mailbox', async ({ page }) => {
    const seen = await stub(page)
    const panel = await openPanel(page)

    await panel.getByRole('button', { name: 'Whole mailbox' }).click()
    await expect(panel.getByText('Measuring the whole mailbox')).toBeVisible()

    await panel.getByRole('button', { name: 'Analyse', exact: true }).click()
    expect(seen.analyseBodies.at(-1)).toMatchObject({ query: '-in:spam' })
  })
})

/*
 * Two hundred senders is a lot to read. Narrowing them is typing, not another
 * few minutes of Gmail quota to answer a question the last run already covered.
 */
test('a sender search filters the results already in hand', async ({ page }) => {
  const seen = await stub(page)
  const panel = await openPanel(page)
  await panel.getByRole('button', { name: 'Analyse', exact: true }).click()
  await expect(panel.getByText('Kapil Gupta')).toBeVisible()

  const before = seen.analyseBodies.length
  await panel.getByPlaceholder('Find a sender in these results').fill('shop')

  await expect(panel.getByText('noreply@shop.test')).toBeVisible()
  await expect(panel.getByText('Kapil Gupta')).toBeHidden()

  // Nothing was re-run to answer it.
  expect(seen.analyseBodies).toHaveLength(before)
})

/*
 * Reported from Sent: "163 messages match" beside a sender list whose first
 * three rows added to over five thousand.
 *
 * The totals come from Gmail and honoured the folder; the sender rollup came
 * from the local index and ignored the query entirely, counting the whole
 * mailbox. Two numbers on one screen measuring different things, which is the
 * same failure as the inbox/analysis mismatch and in a worse place — inside a
 * single panel.
 */
test.describe('the totals and the sender list measure the same thing', () => {
  test('the run carries its scope structurally, not only as a query', async ({
    page,
  }) => {
    const seen = await stub(page)
    const panel = await openPanel(page)
    await panel.getByRole('button', { name: 'Analyse', exact: true }).click()

    expect(seen.analyseBodies.at(-1)).toMatchObject({
      query: 'in:inbox',
      scope: { folder: 'inbox' },
    })
  })

  test('every folder sends its own, drafts included', async ({ page }) => {
    const seen = await stub(page)
    await page.goto('/')

    for (const [label, folder] of [
      ['Sent', 'sent'],
      ['Drafts', 'drafts'],
      ['Spam', 'spam'],
      ['Trash', 'trash'],
    ] as const) {
      await page.getByRole('button', { name: label, exact: true }).click()
      await page.getByRole('button', { name: 'Analyse mailbox' }).click()

      const panel = page.getByRole('complementary', { name: 'Mailbox analysis' })
      // "Analyse" the first time, "Run again" once a stored run comes back.
      await panel
        .getByRole('button', { name: /^(Analyse|Run again)$/ })
        .click()

      expect(seen.analyseBodies.at(-1)).toMatchObject({
        query: `in:${folder}`,
        scope: { folder },
      })

      await panel.getByRole('button', { name: 'Close' }).click()
    }
  })

  test('the age and date filters travel in both halves', async ({ page }) => {
    const seen = await stub(page)
    const panel = await openPanel(page)

    await panel.getByRole('button', { name: 'Age', exact: true }).click()
    await panel.getByRole('option', { name: 'Older than a year' }).click()
    await panel.getByRole('button', { name: 'Analyse', exact: true }).click()

    // The Gmail query and the index query have to agree, or the halves drift
    // apart again in a way nothing on screen would reveal.
    expect(seen.analyseBodies.at(-1)).toMatchObject({
      query: 'in:inbox older_than:1y',
      scope: { folder: 'inbox', olderThanDays: 365 },
    })
  })
})

/*
 * The list is scanned, not read. A run brings back every sender — there is no
 * cap any more — so the panel draws a screenful and keeps the rest a click
 * away, while everything that acts on the list acts on all of it.
 */
test.describe('a long sender list', () => {
  const MANY = {
    ...ANALYSIS,
    senders: Array.from({ length: 250 }, (_, n) => ({
      address: `sender${n}@example.test`,
      name: `Sender ${n}`,
      count: 250 - n,
      withAttachment: 0,
      byAccount: { 'acc-1': { count: 250 - n, withAttachment: 0 } },
    })),
  }

  test('draws a hundred, and loads more on request', async ({ page }) => {
    await stub(page, MANY)
    const panel = await openPanel(page)
    await panel.getByRole('button', { name: 'Analyse', exact: true }).click()

    const rows = panel.locator('.analytics__senders li')
    await expect(rows).toHaveCount(100)
    await expect(panel.getByText('Showing 100 of 250 senders')).toBeVisible()

    await panel.getByRole('button', { name: /Load 100 more/ }).click()
    await expect(rows).toHaveCount(200)

    await panel.getByRole('button', { name: /Load 50 more/ }).click()
    await expect(rows).toHaveCount(250)
    await expect(panel.getByText(/Showing .* senders/)).toBeHidden()
  })

  /*
   * The load limit is about rendering, not about what is in hand — so "select
   * all" means all of them, not the hundred that happen to be drawn.
   */
  test('Select all takes every sender, not the visible hundred', async ({
    page,
  }) => {
    await stub(page, MANY)
    const panel = await openPanel(page)
    await panel.getByRole('button', { name: 'Analyse', exact: true }).click()

    await expect(panel.locator('.analytics__senders li')).toHaveCount(100)
    await panel.getByLabel('Select all').check()

    await expect(panel.getByText('250 selected · 31,375 messages')).toBeVisible()
  })

  test('the search runs across all of them, not the drawn ones', async ({
    page,
  }) => {
    await stub(page, MANY)
    const panel = await openPanel(page)
    await panel.getByRole('button', { name: 'Analyse', exact: true }).click()

    // Sender 240 is far below the first hundred rows.
    await panel
      .getByPlaceholder('Find a sender in these results')
      .fill('sender240@')

    await expect(panel.locator('.analytics__senders li')).toHaveCount(1)
    await expect(panel.getByText('sender240@example.test')).toBeVisible()
  })
})

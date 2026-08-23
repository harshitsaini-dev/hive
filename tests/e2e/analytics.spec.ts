import { expect, test, type Page } from '@playwright/test'

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
  senders: [
    {
      address: 'kapil@example.test',
      name: 'Kapil Gupta',
      count: 812,
      withAttachment: 96,
    },
    { address: 'noreply@shop.test', name: 'Shop', count: 240, withAttachment: 0 },
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

test.describe('mailbox analysis', () => {
  test('reports the split between mail with and without attachments', async ({
    page,
  }) => {
    await stub(page)
    const panel = await openPanel(page)
    await panel.getByRole('button', { name: 'Analyse', exact: true }).click()

    await expect(panel.getByText('103,412', { exact: true })).toBeVisible()
    await expect(panel.getByText('21,003', { exact: true })).toBeVisible()
    await expect(panel.getByText('82,409', { exact: true })).toBeVisible()

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

    await panel
      .getByRole('button', { name: 'Account to analyse', exact: true })
      .click()
    await panel.getByRole('option', { name: 'second@example.test' }).click()

    await panel.getByRole('button', { name: 'Age', exact: true }).click()
    await panel.getByRole('option', { name: 'Older than a year' }).click()

    await panel.getByRole('button', { name: 'Analyse', exact: true }).click()
    await expect(panel.getByText('103,412', { exact: true })).toBeVisible()

    expect(seen.analyseBodies.at(-1)).toMatchObject({
      accountId: 'acc-2',
      query: '-in:spam older_than:1y',
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

    page.once('dialog', (dialog) => void dialog.accept())
    await panel.getByRole('button', { name: 'Clear' }).first().click()

    await expect(page.getByText(/Moved 6 messages/)).toBeVisible()

    // Scoped to that sender, and excluding what is already binned.
    expect(seen.resolveBodies.at(-1)).toMatchObject({
      query: '-in:spam from:kapil@example.test -in:trash',
    })
    expect(seen.trashBodies).toHaveLength(2)
    expect(deleteForeverCalled).toBe(false)
  })

  test('a cancelled confirmation touches nothing', async ({ page }) => {
    const seen = await stub(page)

    const panel = await openPanel(page)
    await panel.getByRole('button', { name: 'Analyse', exact: true }).click()
    await expect(panel.getByText('Kapil Gupta')).toBeVisible()

    page.once('dialog', (dialog) => void dialog.dismiss())
    await panel.getByRole('button', { name: 'Clear' }).first().click()

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

  await panel.getByRole('button', { name: 'View' }).first().click()

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
    await expect(panel.getByRole('button', { name: 'Clear' }).first()).toBeEnabled()

    await panel.getByRole('button', { name: 'Age', exact: true }).click()
    await panel.getByRole('option', { name: 'Older than a year' }).click()

    await expect(panel.getByText(/Filters have changed/)).toBeVisible()
    await expect(
      panel.getByRole('button', { name: 'Clear' }).first(),
    ).toBeDisabled()

    // Looking is still fine — it is reading, not destroying.
    await expect(panel.getByRole('button', { name: 'View' }).first()).toBeEnabled()
  })
})

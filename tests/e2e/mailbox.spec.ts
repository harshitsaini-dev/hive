import { expect, test, type Page } from '@playwright/test'

/**
 * Mailbox behaviour, with the API stubbed.
 *
 * These run against a fake because the real path needs a connected Gmail
 * account, which CI cannot have. What is being tested here is the part that
 * would actually hurt if wrong: that permanent deletion cannot be reached
 * without deliberately confirming it.
 */

const ACCOUNT = {
  id: 'acc-1',
  gmailAddress: 'tester@example.test',
  status: 'active' as const,
  connectedAt: '2026-08-01T00:00:00.000Z',
  lastSyncedAt: null,
}

function messages(count: number, inTrash: boolean) {
  return Array.from({ length: count }, (_, index) => ({
    gmailMessageId: `${inTrash ? 'trash' : 'inbox'}-${index}`,
    threadId: `thread-${index}`,
    accountId: ACCOUNT.id,
    gmailAddress: ACCOUNT.gmailAddress,
    from: `Sender ${index} <sender${index}@example.test>`,
    subject: `Message ${index}`,
    snippet: `Preview of message ${index}`,
    labels: inTrash ? ['TRASH'] : ['INBOX'],
    receivedAt: new Date(Date.UTC(2026, 7, 20, 12, index)).toISOString(),
  }))
}

/** Records what the page asked the server to do. */
interface Calls {
  trash: number
  restore: number
  deleteForever: number
  lastDeletePayload: unknown
  lastTrashPayload: unknown
  resolveCalls: number
  /** Every `q` the page has searched for, oldest first. */
  queries: string[]
}

async function stubApi(page: Page): Promise<Calls> {
  const calls: Calls = {
    trash: 0,
    restore: 0,
    deleteForever: 0,
    lastDeletePayload: null,
    lastTrashPayload: null,
    resolveCalls: 0,
    queries: [],
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
      body: JSON.stringify({ accounts: [ACCOUNT] }),
    }),
  )

  await page.route('**/api/messages?**', (route) => {
    const query = new URL(route.request().url()).searchParams.get('q') ?? ''
    calls.queries.push(query)
    const inTrash = query.includes('in:trash') && !query.includes('-in:trash')

    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        messages: messages(3, inTrash),
        accounts: [
          { accountId: ACCOUNT.id, gmailAddress: ACCOUNT.gmailAddress, error: null },
        ],
        skipped: [],
      }),
    })
  })

  // Stands in for a query that matches far more than one page.
  await page.route('**/api/messages/resolve-query', (route) => {
    calls.resolveCalls += 1
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        messageIds: Array.from({ length: 137 }, (_, i) => 'bulk-' + i),
        count: 137,
        truncated: false,
        limit: 5000,
      }),
    })
  })

  await page.route('**/api/messages/trash', (route) => {
    calls.trash += 1
    calls.lastTrashPayload = route.request().postDataJSON()
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ trashed: 1 }),
    })
  })

  await page.route('**/api/messages/restore', (route) => {
    calls.restore += 1
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ restored: 1 }),
    })
  })

  await page.route('**/api/messages/delete-forever', (route) => {
    calls.deleteForever += 1
    calls.lastDeletePayload = route.request().postDataJSON()
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ deleted: 1 }),
    })
  })

  return calls
}

test.describe('mailbox', () => {
  test.beforeEach(async ({ page }) => {
    await stubApi(page)
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Inbox', level: 1 })).toBeVisible()
  })

  test('lists mail and offers Gmail search syntax', async ({ page }) => {
    await expect(page.getByText('Sender 0', { exact: true })).toBeVisible()
    await expect(page.getByText('Message 0', { exact: true })).toBeVisible()

    // Filters, not syntax: the point is that none of this needs Gmail's
    // query language typed by hand.
    await expect(page.getByRole('searchbox', { name: 'Search words' })).toBeVisible()
    await expect(page.getByLabel('From')).toBeVisible()
    await expect(page.getByLabel('Has attachment')).toBeVisible()
    await expect(page.getByLabel('Unread only')).toBeVisible()
  })

  test('selecting mail reveals bulk actions', async ({ page }) => {
    await expect(page.getByText(/selected/)).toBeHidden()

    await page.getByLabel(/Select page/).check()

    await expect(page.getByText('3 selected on this page')).toBeVisible()
    await expect(page.getByRole('button', { name: /Move \d+ to Trash/ })).toBeVisible()
    // Permanent deletion is not offered from the inbox at all.
    await expect(page.getByRole('button', { name: /Delete \d+ forever/ })).toBeHidden()
  })

  test('the Trash tab offers restore and delete forever', async ({ page }) => {
    await page.getByRole('button', { name: 'Trash' }).click()
    await page.getByLabel(/Select page/).check()

    await expect(page.getByRole('button', { name: /Restore \d+/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /Delete \d+ forever/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /Move \d+ to Trash/ })).toBeHidden()
  })
})

test.describe('permanent deletion', () => {
  test('cannot be triggered without typing the confirmation', async ({ page }) => {
    const calls = await stubApi(page)
    await page.goto('/')

    await page.getByRole('button', { name: 'Trash' }).click()
    await page.getByLabel(/Select page/).check()
    await page.getByRole('button', { name: /Delete \d+ forever/ }).click()

    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText(/cannot be undone/i)).toBeVisible()
    await expect(dialog.getByText(/Permanently delete 3 messages/)).toBeVisible()

    // The confirm button stays dead until the phrase matches exactly.
    const confirm = dialog.getByRole('button', { name: 'Delete forever' })
    await expect(confirm).toBeDisabled()

    await dialog.getByLabel(/Type/).fill('delete')
    await expect(confirm).toBeDisabled()

    await dialog.getByLabel(/Type/).fill('permanently delete')
    await expect(confirm).toBeEnabled()

    expect(calls.deleteForever, 'nothing sent before confirming').toBe(0)
  })

  test('Escape and Cancel both abandon it without deleting', async ({ page }) => {
    const calls = await stubApi(page)
    await page.goto('/')

    await page.getByRole('button', { name: 'Trash' }).click()
    await page.getByLabel(/Select page/).check()

    await page.getByRole('button', { name: /Delete \d+ forever/ }).click()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('alertdialog')).toBeHidden()

    await page.getByRole('button', { name: /Delete \d+ forever/ }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByRole('alertdialog')).toBeHidden()

    expect(calls.deleteForever).toBe(0)
  })

  test('sends the confirmation phrase the server also demands', async ({ page }) => {
    const calls = await stubApi(page)
    await page.goto('/')

    await page.getByRole('button', { name: 'Trash' }).click()
    await page.getByLabel(/Select page/).check()
    await page.getByRole('button', { name: /Delete \d+ forever/ }).click()

    const dialog = page.getByRole('alertdialog')
    await dialog.getByLabel(/Type/).fill('permanently delete')
    await dialog.getByRole('button', { name: 'Delete forever' }).click()

    await expect(page.getByText(/Permanently deleted 3/)).toBeVisible()

    expect(calls.deleteForever).toBe(1)
    // Defence in depth: the client must send it, and the server checks it too.
    expect(calls.lastDeletePayload).toMatchObject({
      confirm: 'permanently delete',
      accountId: ACCOUNT.id,
    })
  })

  test('keeps keyboard focus inside the dialog', async ({ page }) => {
    await stubApi(page)
    await page.goto('/')

    await page.getByRole('button', { name: 'Trash' }).click()
    await page.getByLabel(/Select page/).check()
    await page.getByRole('button', { name: /Delete \d+ forever/ }).click()

    const dialog = page.getByRole('alertdialog')
    await expect(dialog.getByLabel(/Type/)).toBeFocused()

    // Tabbing repeatedly must never land on the page behind the dialog.
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab')
      const inside = await dialog.evaluate((element) =>
        element.contains(document.activeElement),
      )
      expect(inside, 'focus escaped the confirmation dialog').toBe(true)
    }
  })
})

/**
 * Acting on a whole search rather than one page.
 *
 * This is the product's headline claim — "clean out thousands at a time" — and
 * it is also the path with the largest blast radius, so the count shown must
 * be the count acted on.
 */
test.describe('selecting a whole search', () => {
  test('is offered alongside select-page, not hidden behind it', async ({
    page,
  }) => {
    await stubApi(page)
    await page.goto('/')

    /*
     * Both choices are present from the start. Hiding "select all" until the
     * page was fully ticked made the two look like one escalating control,
     * which is exactly the confusion that a loaded count of 1,264 against a
     * real 1,323 caused.
     */
    await expect(page.getByLabel(/Select page/)).toBeVisible()
    await expect(
      page.getByRole('button', { name: /Select all matching/ }),
    ).toBeEnabled()
  })

  test('acts on every match, not just the visible page', async ({ page }) => {
    const calls = await stubApi(page)
    await page.goto('/')

    await page.getByLabel(/Select page/).check()
    await page
      .getByRole('button', { name: /Select all matching/ })
      .click()

    // The real count replaces the page count everywhere it is shown.
    await expect(page.getByText(/137 selected/)).toBeVisible()
    const trash = page.getByRole('button', { name: /Move 137 to Trash/ })
    await expect(trash).toBeVisible()

    await trash.click()
    await expect(page.getByText(/Moved to Trash: 137/)).toBeVisible()

    expect(calls.resolveCalls).toBe(1)
    // The button said 137, so 137 IDs must have been sent — not the 3 on screen.
    expect(
      (calls.lastTrashPayload as { messageIds: string[] }).messageIds,
    ).toHaveLength(137)
  })

  test('can be narrowed back to the visible page', async ({ page }) => {
    const calls = await stubApi(page)
    await page.goto('/')

    await page.getByLabel(/Select page/).check()
    await page
      .getByRole('button', { name: /Select all matching/ })
      .click()
    await expect(page.getByText(/137 selected/)).toBeVisible()

    await page.getByRole('button', { name: /Just this page instead/ }).click()
    await expect(page.getByText(/3 selected/)).toBeVisible()

    await page.getByRole('button', { name: /Move 3 to Trash/ }).click()
    expect(
      (calls.lastTrashPayload as { messageIds: string[] }).messageIds,
    ).toHaveLength(3)
  })

  test('warns when the match is larger than the cap', async ({ page }) => {
    await stubApi(page)

    // Re-route so this query reports hitting the ceiling.
    await page.route('**/api/messages/resolve-query', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          messageIds: Array.from({ length: 5000 }, (_, i) => 'capped-' + i),
          count: 5000,
          truncated: true,
          limit: 5000,
        }),
      }),
    )

    await page.goto('/')
    await page.getByLabel(/Select page/).check()
    await page
      .getByRole('button', { name: /Select all matching/ })
      .click()

    // Said before the action, not discovered after it.
    await expect(page.getByText(/matches more than 5,000/)).toBeVisible()
    await expect(page.getByText(/run the action again/)).toBeVisible()
  })

  test('a whole-search permanent delete confirms the real count', async ({
    page,
  }) => {
    const calls = await stubApi(page)
    await page.goto('/')

    await page.getByRole('button', { name: 'Trash' }).click()
    await page.getByLabel(/Select page/).check()
    await page
      .getByRole('button', { name: /Select all matching/ })
      .click()

    await page.getByRole('button', { name: /Delete 137 forever/ }).click()

    const dialog = page.getByRole('alertdialog')
    // The dialog must state what will actually be destroyed.
    await expect(dialog.getByText(/Permanently delete 137 messages/)).toBeVisible()

    await dialog.getByLabel(/Type/).fill('permanently delete')
    await dialog.getByRole('button', { name: 'Delete forever' }).click()

    await expect(page.getByText(/Permanently deleted 137/)).toBeVisible()
    expect(
      (calls.lastDeletePayload as { messageIds: string[] }).messageIds,
    ).toHaveLength(137)
  })
})

/**
 * Progress on a large bulk action.
 *
 * The server keeps working after the response goes out and the client polls a
 * job — the only shape that works here, because Vercel proxies /api to Render
 * and does not carry WebSocket upgrades.
 */
test.describe('bulk progress', () => {
  test('polls a job and reports progress for a large selection', async ({
    page,
  }) => {
    await stubApi(page)

    // A query that resolves to more than the synchronous threshold.
    await page.route('**/api/messages/resolve-query', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          messageIds: Array.from({ length: 900 }, (_, i) => 'big-' + i),
          count: 900,
          truncated: false,
          limit: 5000,
        }),
      }),
    )

    let trashBody: { background?: boolean } | null = null
    await page.route('**/api/messages/trash', (route) => {
      trashBody = route.request().postDataJSON()
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jobId: 'job-1' }),
      })
    })

    let polls = 0
    await page.route('**/api/messages/jobs/job-1', (route) => {
      polls += 1
      const processed = polls === 1 ? 400 : 900
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'job-1',
          action: 'trash',
          total: 900,
          processed,
          status: polls === 1 ? 'running' : 'done',
          error: null,
        }),
      })
    })

    await page.goto('/')
    await page.getByLabel(/Select page/).check()
    await page
      .getByRole('button', { name: /Select all matching/ })
      .click()
    await expect(page.getByText(/900 selected/)).toBeVisible()

    await page.getByRole('button', { name: /Move 900 to Trash/ }).click()

    // The bar reports the job's own count, not a guess.
    await expect(page.getByRole('progressbar')).toBeVisible()
    await expect(page.getByText(/400 of 900/)).toBeVisible()

    await expect(page.getByText(/Moved to Trash: 900/)).toBeVisible()
    // Large selections ask for a job; small ones must not. The re-routed
    // handler above owns the counting here, not the shared stub.
    expect(trashBody?.background).toBe(true)
  })

  test('a small selection stays synchronous', async ({ page }) => {
    await stubApi(page)

    let body: { background?: boolean } | null = null
    await page.route('**/api/messages/trash', (route) => {
      body = route.request().postDataJSON()
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ trashed: 3 }),
      })
    })

    await page.goto('/')
    await page.getByLabel(/Select page/).check()
    await page.getByRole('button', { name: /Move 3 to Trash/ }).click()

    await expect(page.getByText(/Moved to Trash: 3/)).toBeVisible()
    // No job, so no progress bar to flash on screen.
    await expect(page.getByRole('progressbar')).toBeHidden()
    expect(body?.background).toBe(false)
  })
})

/*
 * Reported against the deployed app: a search for a word plus "has
 * attachment" returned nothing while the mail plainly existed. It had been
 * archived, and archived mail is not `in:inbox` — so the folder the user
 * happened to be standing in was quietly hiding most of the mailbox from
 * their own search.
 */
test.describe('how far a search reaches', () => {
  test('a search stays in the folder it was made from', async ({ page }) => {
    const calls = await stubApi(page)
    await page.goto('/')

    // Browsing is still the folder. That part was never wrong.
    await expect.poll(() => calls.queries.at(-1)).toBe('in:inbox')

    await page.getByPlaceholder('Search words in subject or body').fill('mega')
    await page.getByLabel('Has attachment').check()
    await page.getByRole('button', { name: 'Search', exact: true }).click()

    /*
     * The folder is the default now. It was the other way round, to stop a
     * search of the inbox missing archived mail — and that traded one
     * surprise for another: standing in Sent and searching returned inbound
     * mail, because "everywhere" means exactly that.
     */
    await expect.poll(() => calls.queries.at(-1)).toBe(
      'in:inbox mega has:attachment',
    )
    await expect(page.getByText(/Searching Inbox only/)).toBeVisible()
  })

  test('the reach can be widened, and narrowed again', async ({ page }) => {
    const calls = await stubApi(page)
    await page.goto('/')

    await page.getByPlaceholder('Search words in subject or body').fill('mega')
    await page.getByRole('button', { name: 'Search', exact: true }).click()
    await expect.poll(() => calls.queries.at(-1)).toBe('in:inbox mega')

    // Archived mail is a click away, and the header says which reach is in
    // force — so neither answer is the silent one.
    await page.getByRole('button', { name: 'Search everywhere' }).click()
    await expect.poll(() => calls.queries.at(-1)).toBe('-in:spam mega')

    await page.getByRole('button', { name: 'Only search Inbox' }).click()
    await expect.poll(() => calls.queries.at(-1)).toBe('in:inbox mega')
  })

  test('the Trash view keeps its scope while searching', async ({ page }) => {
    const calls = await stubApi(page)
    await page.goto('/')
    await page.getByRole('button', { name: 'Trash' }).click()

    await page.getByPlaceholder('Search words in subject or body').fill('mega')
    await page.getByRole('button', { name: 'Search', exact: true }).click()

    // The bin is the subject here, so leaving it would make the view useless.
    await expect.poll(() => calls.queries.at(-1)).toBe('in:trash mega')
  })
})

/** Drives the custom calendar: open it, set month and year, click the day. */
async function pickDate(
  page: Page,
  field: string,
  year: number,
  month: string,
  day: string,
) {
  await page.getByRole('button', { name: field }).click()
  const panel = page.getByRole('dialog', { name: field })

  // exact, or "Month" also matches the "Previous month" chevron beside it.
  await panel.getByRole('button', { name: 'Year', exact: true }).click()
  await panel.getByRole('option', { name: `${year}`, exact: true }).click()
  await panel.getByRole('button', { name: 'Month', exact: true }).click()
  await panel.getByRole('option', { name: month, exact: true }).click()

  await panel.getByRole('gridcell', { name: day, exact: true }).click()
}

/*
 * "Older than a year" cannot express "that job I had in 2019", and the raw
 * Gmail-syntax box is not an answer for someone who came here to avoid
 * learning the syntax.
 */
test.describe('custom date range', () => {
  test('compiles a range into after: and before:', async ({ page }) => {
    const calls = await stubApi(page)
    await page.goto('/')

    await pickDate(page, 'Earliest date', 2019, 'January', '1 Jan 2019')
    await pickDate(page, 'Latest date', 2019, 'December', '31 Dec 2019')
    await page.getByRole('button', { name: 'Search', exact: true }).click()

    /*
     * The end date is pushed out by a day on purpose: Gmail's `before:` is
     * exclusive, so asking for a range ending on the 31st and quietly
     * stopping on the 30th would be a filter that lies.
     */
    await expect.poll(() => calls.queries.at(-1)).toBe(
      'in:inbox after:2019/01/01 before:2020/01/01',
    )
  })

  test('either end works on its own', async ({ page }) => {
    const calls = await stubApi(page)
    await page.goto('/')

    await pickDate(page, 'Earliest date', 2020, 'June', '15 Jun 2020')
    await page.getByRole('button', { name: 'Search', exact: true }).click()
    await expect.poll(() => calls.queries.at(-1)).toBe(
      'in:inbox after:2020/06/15',
    )

    await page.getByRole('button', { name: 'Clear dates' }).click()
    await pickDate(page, 'Latest date', 2020, 'June', '15 Jun 2020')
    await page.getByRole('button', { name: 'Search', exact: true }).click()
    await expect.poll(() => calls.queries.at(-1)).toBe(
      'in:inbox before:2020/06/16',
    )
  })
})

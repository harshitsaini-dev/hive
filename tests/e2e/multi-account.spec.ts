import { expect, test, type Page } from '@playwright/test'

/**
 * The unified view across several mailboxes.
 *
 * Worth its own file because almost everything here is a code path that never
 * ran until a second account existed: results merge by date across accounts,
 * bulk actions have to split back apart by account before sending, and
 * pagination carries one Gmail cursor per mailbox rather than one for the
 * whole search.
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
  searchUrls: string[]
  trashPayloads: { accountId: string; messageIds: string[] }[]
}

/** Interleaves two mailboxes so the merge is actually exercised. */
function message(accountIndex: number, index: number, minute: number) {
  const account = ACCOUNTS[accountIndex]!
  return {
    gmailMessageId: `${account.id}-m${index}`,
    threadId: `t${index}`,
    accountId: account.id,
    gmailAddress: account.gmailAddress,
    from: `Sender ${accountIndex}-${index} <s@example.test>`,
    subject: `Message ${accountIndex}-${index}`,
    snippet: 'preview',
    labels: ['INBOX'],
    receivedAt: new Date(Date.UTC(2026, 7, 20, 12, minute)).toISOString(),
  }
}

async function stub(page: Page): Promise<Seen> {
  const seen: Seen = { searchUrls: [], trashPayloads: [] }

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
    const url = new URL(route.request().url())
    seen.searchUrls.push(url.search)

    const isSecondPage = url.searchParams.has('pageToken')

    /*
     * Second page comes only from account two. That is the case the cursor
     * logic has to get right: an account that has run out must not be asked
     * again and repeat its first page.
     */
    const messages = isSecondPage
      ? [message(1, 3, 5)]
      : [message(0, 1, 40), message(1, 1, 35), message(0, 2, 20)]

    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        messages,
        nextPageToken: isSecondPage ? null : 'cursor-abc',
        accounts: ACCOUNTS.map((account) => ({
          accountId: account.id,
          gmailAddress: account.gmailAddress,
          error: null,
        })),
        skipped: [],
      }),
    })
  })

  await page.route('**/api/messages/trash', (route) => {
    seen.trashPayloads.push(
      route.request().postDataJSON() as Seen['trashPayloads'][number],
    )
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ trashed: 1 }),
    })
  })

  return seen
}

test.describe('several mailboxes', () => {
  test('merges results by date, newest first', async ({ page }) => {
    await stub(page)
    await page.goto('/')

    await expect(page.getByText('(3 shown)')).toBeVisible()

    // 12:40 (acc-1), 12:35 (acc-2), 12:20 (acc-1) — interleaved, not grouped.
    const subjects = await page.locator('.message__subject').allInnerTexts()
    expect(subjects).toEqual(['Message 0-1', 'Message 1-1', 'Message 0-2'])
  })

  test('labels which mailbox each message came from', async ({ page }) => {
    await stub(page)
    await page.goto('/')

    // Only shown when there is more than one account — otherwise it is noise.
    await expect(page.getByText('first@example.test').first()).toBeVisible()
    await expect(page.getByText('second@example.test').first()).toBeVisible()
  })

  test('splits a bulk action back apart by account', async ({ page }) => {
    const seen = await stub(page)
    await page.goto('/')

    await page.getByLabel(/Select page/).check()
    await page.getByRole('button', { name: /Move 3 to Trash/ }).click()

    await expect(page.getByText(/Moved to Trash: 3/)).toBeVisible()

    /*
     * Two calls, not one. A Gmail message id only means anything against the
     * mailbox it came from, so a merged selection has to be regrouped before
     * it is sent anywhere.
     */
    expect(seen.trashPayloads).toHaveLength(2)

    const byAccount = Object.fromEntries(
      seen.trashPayloads.map((payload) => [
        payload.accountId,
        payload.messageIds,
      ]),
    )
    expect(byAccount['acc-1']).toEqual(['acc-1-m1', 'acc-1-m2'])
    expect(byAccount['acc-2']).toEqual(['acc-2-m1'])
  })

  test('carries one cursor for the whole merged page', async ({ page }) => {
    const seen = await stub(page)
    await page.goto('/')

    /*
     * Paging stays a decision, not something the view does on its own. Every
     * message on a page costs a metadata read, and fetching the rest unasked
     * spent a minute's Gmail quota in one go.
     */
    await expect(page.getByText('(3 shown)')).toBeVisible()
    await page.getByRole('button', { name: /Load 500 more/ }).click()
    await expect(page.getByText('(4 shown)')).toBeVisible()
    await expect(page.getByText('All 4 matches loaded')).toBeVisible()

    // The follow-up request hands the cursor straight back, unmodified.
    expect(seen.searchUrls.at(-1) ?? '').toContain('pageToken=cursor-abc')

    // Appended, not replaced — a selection made before paging survives.
    const subjects = await page.locator('.message__subject').allInnerTexts()
    expect(subjects).toHaveLength(4)
    expect(subjects.at(-1)).toBe('Message 1-3')
  })

  /*
   * The palette lists results from every folder of every mailbox, so handing
   * its text to an `in:inbox` view would silently drop most of what it just
   * showed. A user searching for a message they archived last year has to end
   * up looking at it, not at an empty inbox.
   */
  test('a palette search stays unscoped when it opens in the mail view', async ({
    page,
  }) => {
    const seen = await stub(page)
    await page.goto('/')
    await expect(page.getByText('(3 shown)')).toBeVisible()

    await page.keyboard.press('Control+k')
    await page.getByPlaceholder('Search every connected account').fill('invoice')

    // The palette itself asks Gmail for everything, with no folder scope.
    await expect
      .poll(() => decodeURIComponent(seen.searchUrls.at(-1) ?? ''))
      .toContain('q=invoice')
    expect(decodeURIComponent(seen.searchUrls.at(-1) ?? '')).not.toContain(
      'in:inbox',
    )

    await page.getByRole('button', { name: 'See all results' }).click()

    // And so does the view it hands off to.
    await expect
      .poll(() => decodeURIComponent(seen.searchUrls.at(-1) ?? ''))
      .toContain('invoice')
    expect(decodeURIComponent(seen.searchUrls.at(-1) ?? '')).not.toContain(
      'in:inbox',
    )
  })

  test('leaving for a nav destination drops the palette search', async ({
    page,
  }) => {
    const seen = await stub(page)
    await page.goto('/')
    await expect(page.getByText('(3 shown)')).toBeVisible()

    await page.keyboard.press('Control+k')
    await page.getByPlaceholder('Search every connected account').fill('invoice')
    await page.getByRole('button', { name: 'See all results' }).click()
    await expect
      .poll(() => decodeURIComponent(seen.searchUrls.at(-1) ?? ''))
      .toContain('invoice')

    // Clicking Inbox means Inbox, not "the everywhere-search I just ran".
    await page.getByRole('button', { name: 'Inbox' }).click()
    await expect
      .poll(() => decodeURIComponent(seen.searchUrls.at(-1) ?? ''))
      .toContain('in:inbox')
    expect(decodeURIComponent(seen.searchUrls.at(-1) ?? '')).not.toContain(
      'invoice',
    )
  })

  test('can narrow the search to one mailbox', async ({ page }) => {
    const seen = await stub(page)
    await page.goto('/')

    await expect(page.getByText('(3 shown)')).toBeVisible()

    // exact, or the sidebar's 'Accounts' nav item matches too.
    await page.getByRole('button', { name: 'Account', exact: true }).click()
    await page.getByRole('option', { name: 'second@example.test' }).click()

    await expect
      .poll(() => seen.searchUrls.at(-1) ?? '')
      .toContain('accountId=acc-2')
  })
})

/*
 * A cursor that fails to advance replays the page it just returned. The
 * symptom is not an error: the list simply grows with the same messages
 * again, which reads as "the filter stopped being applied further down".
 */
test('a cursor that repeats itself does not duplicate the list', async ({
  page,
}) => {
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

  // Always the same page, always a token — a mailbox stuck in a loop.
  await page.route('**/api/messages?**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        messages: [message(0, 1, 40), message(1, 1, 35)],
        nextPageToken: 'cursor-abc',
        accounts: ACCOUNTS.map((account) => ({
          accountId: account.id,
          gmailAddress: account.gmailAddress,
          error: null,
        })),
        skipped: [],
      }),
    }),
  )

  await page.goto('/')
  await expect(page.getByText('(2 shown)')).toBeVisible()

  await page.getByRole('button', { name: /Load 500 more/ }).click()

  // Still two, and the button is gone rather than offering another lap.
  await expect(page.getByText('All 2 matches loaded')).toBeVisible()
  expect(await page.locator('.message__subject').count()).toBe(2)
})

import { expect, test, type Page } from '@playwright/test'

/**
 * Searching from the local index instead of Gmail.
 *
 * A page of 500 from Gmail is 500 metadata reads; from the index it is one
 * query. The bar for using it is that the answer must be *identical* — which
 * is why the interesting tests here are the ones about when it must NOT be
 * used.
 *
 * The rule that matters most: **Gmail searches message bodies and the index
 * does not hold them.** Storing bodies is exactly what the privacy policy
 * forbids, so any query with free text in it goes to Gmail, every time. A
 * text search that quietly stopped matching words inside messages would be a
 * worse product wearing a faster one's clothes.
 */

const ACCOUNT = {
  id: 'acc-1',
  gmailAddress: 'me@example.test',
  status: 'active' as const,
  connectedAt: '2026-08-01T00:00:00.000Z',
  lastSyncedAt: null,
}

interface Seen {
  /** The full query string of every search, so both halves are inspectable. */
  searches: URLSearchParams[]
}

async function stub(page: Page): Promise<Seen> {
  const seen: Seen = { searches: [] }

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
    const params = new URL(route.request().url()).searchParams
    seen.searches.push(params)

    // Mirrors the server: a structured query is answered with a real total
    // and an offset; everything else with a cursor and no total.
    const structured = params.get('structured')
    const offset = Number(params.get('offset') ?? 0)

    // A couple of rows, because the count line only exists beside a list.
    const messages = [0, 1].map((n) => ({
      gmailMessageId: `m${offset + n}`,
      threadId: `t${offset + n}`,
      accountId: ACCOUNT.id,
      gmailAddress: ACCOUNT.gmailAddress,
      from: 'Sender <s@example.test>',
      subject: `Message ${offset + n}`,
      snippet: 'preview',
      labels: ['INBOX'],
      receivedAt: new Date(Date.UTC(2026, 7, 20, 12, offset + n)).toISOString(),
    }))

    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        structured
          ? {
              source: 'index',
              total: 1_323,
              nextOffset: 100,
              nextPageToken: null,
              messages,
              accounts: [],
              skipped: [],
            }
          : {
              source: 'gmail',
              total: null,
              nextPageToken: 'cursor-abc',
              messages,
              accounts: [],
              skipped: [],
            },
      ),
    })
  })

  return seen
}

/*
 * Empty-safe on purpose. `expect.poll` retries a *value*, not a throw — so
 * indexing off the end before the first request lands fails the poll outright
 * instead of waiting for it. Locally the request was always there first;
 * headless CI is quicker off the mark.
 */
function last(seen: Seen): URLSearchParams {
  return seen.searches[seen.searches.length - 1] ?? new URLSearchParams()
}

test.describe('index-served search', () => {
  test('browsing a folder offers the index the structural filters', async ({
    page,
  }) => {
    const seen = await stub(page)
    await page.goto('/')

    await expect
      .poll(() => JSON.parse(last(seen).get('structured') ?? 'null'))
      .toEqual({ folder: 'inbox' })

    // `q` still goes too. The server picks; the client does not decide for it.
    expect(last(seen).get('q')).toBe('in:inbox')
  })

  test('attachment, unread and date filters all go structurally', async ({
    page,
  }) => {
    const seen = await stub(page)
    await page.goto('/')

    await page.getByLabel('Has attachment').check()
    await page.getByLabel('Unread only').check()
    await page.getByRole('button', { name: 'Search', exact: true }).click()

    await expect
      .poll(() => JSON.parse(last(seen).get('structured') ?? '{}'))
      .toMatchObject({
        folder: 'all',
        hasAttachment: true,
        unreadOnly: true,
      })
  })

  /*
   * The load-bearing test in this file. If this ever goes green while
   * `structured` is present, searching has quietly stopped looking inside
   * messages.
   */
  test('a text search is never answered from the index', async ({ page }) => {
    const seen = await stub(page)
    await page.goto('/')

    await page
      .getByPlaceholder('Search words in subject or body')
      .fill('invoice')
    await page.getByRole('button', { name: 'Search', exact: true }).click()

    await expect.poll(() => last(seen).get('q')).toContain('invoice')
    expect(last(seen).get('structured')).toBeNull()

    /*
     * And it is still fast, without the index ever holding a body. Gmail
     * answers a search with ids — the cheap half — and the rows behind those
     * ids come from the index. Google still does the matching, inside the
     * messages, exactly as before.
     */
    await expect(page.getByText('Message 0')).toBeVisible()
  })

  test('raw Gmail syntax is never answered from the index either', async ({
    page,
  }) => {
    const seen = await stub(page)
    await page.goto('/')

    await page.getByRole('button', { name: 'Use Gmail syntax' }).click()
    await page.getByLabel('Extra Gmail search terms').fill('larger:5M')
    await page.getByRole('button', { name: 'Search', exact: true }).click()

    await expect.poll(() => last(seen).get('q')).toContain('larger:5M')
    expect(last(seen).get('structured')).toBeNull()
  })

  test('an index-served page states the real total and pages by offset', async ({
    page,
  }) => {
    const seen = await stub(page)
    await page.goto('/')

    /*
     * The number a page is a slice *of*. Reporting "500 loaded" as though it
     * were the answer is the bug this replaces — a mailbox of 1,323 was
     * showing 1,264 and looking like data loss.
     */
    await expect(page.getByText(/Showing .* of 1,323 matches/)).toBeVisible()

    await page.getByRole('button', { name: /Load 100 more/ }).click()
    await expect.poll(() => last(seen).get('offset')).toBe('100')
    expect(last(seen).get('pageToken')).toBeNull()
  })
})

/*
 * The index is what the list reads from now, so anything Hive does to a
 * mailbox has to reach it immediately. Waiting for the next hourly pass means
 * trashing five hundred messages, watching the list refresh, and seeing all
 * five hundred still sitting there — which is indistinguishable from the
 * action having failed.
 */
test('mail trashed from Hive leaves the list at once', async ({ page }) => {
  const rows = [0, 1, 2].map((n) => ({
    gmailMessageId: `m${n}`,
    threadId: `t${n}`,
    accountId: ACCOUNT.id,
    gmailAddress: ACCOUNT.gmailAddress,
    from: 'Sender <s@example.test>',
    subject: `Message ${n}`,
    snippet: 'preview',
    labels: ['INBOX'],
    receivedAt: new Date(Date.UTC(2026, 7, 20, 12, n)).toISOString(),
  }))

  let trashed = false

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

  // Stands in for the server's write-through: once the trash call has been
  // made, the very next search must not return those messages.
  await page.route('**/api/messages?**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        source: 'index',
        total: trashed ? 0 : 3,
        nextOffset: null,
        nextPageToken: null,
        messages: trashed ? [] : rows,
        accounts: [],
        skipped: [],
      }),
    }),
  )

  await page.route('**/api/messages/trash', (route) => {
    trashed = true
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ trashed: 3 }),
    })
  })

  await page.goto('/')
  await expect(page.getByText('Message 0')).toBeVisible()

  await page.getByLabel(/Select page/).check()
  await page.getByRole('button', { name: /Move 3 to Trash/ }).click()

  await expect(page.getByText(/Moved to Trash: 3/)).toBeVisible()
  await expect(page.getByText('Message 0')).toBeHidden()
})

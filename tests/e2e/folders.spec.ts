import { expect, test, type Page } from '@playwright/test'

/**
 * Drafts and Spam as their own destinations.
 *
 * The interesting part is not that they list mail — it is what the app must
 * *not* offer in them. Permanent deletion lives in exactly one place, behind a
 * typed confirmation (ADR 0002), and adding folders is precisely the kind of
 * change that leaks it into three more.
 */

const ACCOUNT = {
  id: 'acc-1',
  gmailAddress: 'me@example.test',
  status: 'active' as const,
  connectedAt: '2026-08-01T00:00:00.000Z',
  lastSyncedAt: null,
}

interface Seen {
  queries: string[]
}

async function stub(page: Page): Promise<Seen> {
  const seen: Seen = { queries: [] }

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
    seen.queries.push(params.get('q') ?? '')
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        messages: [
          {
            gmailMessageId: 'm1',
            threadId: 't1',
            accountId: ACCOUNT.id,
            gmailAddress: ACCOUNT.gmailAddress,
            from: 'Someone <s@example.test>',
            subject: 'A message',
            snippet: 'preview',
            labels: ['INBOX'],
            receivedAt: '2026-08-23T10:00:00.000Z',
          },
        ],
        nextPageToken: null,
        accounts: [],
        skipped: [],
      }),
    })
  })

  return seen
}

test.describe('drafts and spam', () => {
  test('each asks Gmail for its own folder', async ({ page }) => {
    const seen = await stub(page)
    await page.goto('/')

    await page.getByRole('button', { name: 'Drafts' }).click()
    await expect.poll(() => seen.queries.at(-1)).toBe('in:drafts')

    await page.getByRole('button', { name: 'Spam' }).click()
    await expect.poll(() => seen.queries.at(-1)).toBe('in:spam')
  })

  /*
   * Searching from the inbox reaches archived mail — that was a real bug once.
   * Searching from these three must not widen: in each, the folder *is* the
   * question.
   */
  test('a search inside them stays inside them', async ({ page }) => {
    const seen = await stub(page)
    await page.goto('/')

    await page.getByRole('button', { name: 'Spam' }).click()
    await page.getByPlaceholder('Search words in subject or body').fill('offer')
    await page.getByRole('button', { name: 'Search', exact: true }).click()

    await expect.poll(() => seen.queries.at(-1)).toBe('in:spam offer')
  })

  /*
   * The load-bearing one. This branched on `mode === 'inbox'`, which was
   * harmless with two folders and offered permanent deletion in three more
   * the moment there were five.
   */
  test('permanent deletion is offered in Trash and nowhere else', async ({
    page,
  }) => {
    await stub(page)
    await page.goto('/')

    for (const folder of ['Inbox', 'Sent', 'Drafts', 'Spam']) {
      await page.getByRole('button', { name: folder, exact: true }).click()
      await page.getByLabel(/Select page/).check()

      await expect(
        page.getByRole('button', { name: /Move 1 to Trash/ }),
      ).toBeVisible()
      await expect(
        page.getByRole('button', { name: /forever/ }),
      ).toBeHidden()
    }

    await page.getByRole('button', { name: 'Trash', exact: true }).click()
    await page.getByLabel(/Select page/).check()
    await expect(page.getByRole('button', { name: /forever/ })).toBeVisible()
  })
})

/*
 * Reported: Hive's Spam view said "Nothing in Spam" beside a Gmail tab
 * listing nine messages.
 *
 * Gmail's `messages.list` withholds Spam and Trash unless `includeSpamTrash`
 * is set — a gate in front of the results, not a filter on them, and it
 * applies even when the query names the folder. `q=in:spam` without it
 * returns nothing at all, which is indistinguishable from an empty folder.
 */
test.describe('spam and trash reach the server correctly', () => {
  test('the request asks for the folder Gmail hides by default', async ({
    page,
  }) => {
    const asked: string[] = []

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
        body: JSON.stringify({ accounts: [ACCOUNT] }),
      }),
    )
    await page.route('**/api/messages?**', (route) => {
      const params = new URL(route.request().url()).searchParams
      asked.push(
        JSON.stringify({
          q: params.get('q'),
          folder: JSON.parse(params.get('structured') ?? 'null')?.folder,
        }),
      )
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          messages: [],
          nextPageToken: null,
          accounts: [],
          skipped: [],
        }),
      })
    })

    await page.goto('/')

    for (const [label, folder] of [
      ['Spam', 'spam'],
      ['Trash', 'trash'],
    ] as const) {
      await page.getByRole('button', { name: label, exact: true }).click()

      /*
       * Both halves travel: the Gmail query names the folder, and the
       * structured filter does too — the server needs the second to decide
       * whether its own index may answer at all.
       */
      await expect
        .poll(() => JSON.parse(asked.at(-1) ?? '{}'))
        .toEqual({ q: `in:${folder}`, folder })
    }
  })
})

/*
 * Reloading on Sent used to land back in the inbox. The view was in-app state
 * and the address bar knew nothing about it, so a refresh felt like being
 * sent home — and a link to a destination could not exist at all.
 */
test.describe('the address bar knows where you are', () => {
  test('a reload comes back to the same place', async ({ page }) => {
    await stub(page)
    await page.goto('/')

    await page.getByRole('button', { name: 'Drafts' }).click()
    expect(new URL(page.url()).pathname).toBe('/drafts')

    await page.reload()
    await expect(page.getByRole('heading', { name: 'Drafts' })).toBeVisible()
  })

  test('Back walks through where you have been', async ({ page }) => {
    await stub(page)
    await page.goto('/')

    await page.getByRole('button', { name: 'Spam', exact: true }).click()
    await page.getByRole('button', { name: 'Trash', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Trash' })).toBeVisible()

    await page.goBack()
    await expect(page.getByRole('heading', { name: 'Spam' })).toBeVisible()
  })
})

import { expect, test, type Page } from '@playwright/test'

/**
 * Nothing anyone else wrote may set the width of this page.
 *
 * Reported as "the screen is zoomed out on mobile", which is what a phone
 * browser does when the document turns out wider than the viewport: it scales
 * the whole page down to fit. Every screen then looks shrunken with a strip of
 * dead space down one side — and the cause can be a single row that is not
 * even visible at the time.
 *
 * Almost every string Hive renders comes from somewhere else: a sender's name,
 * a subject, an address, a saved query. One of them without a space in it is
 * enough. This file feeds an unbreakable 120-character token through every
 * field of every view and asserts the document still fits the phone.
 *
 * It measures rather than inspects, deliberately. The three separate causes
 * behind this — a flex item that would not shrink, a column sized to its own
 * content, and `overflow-wrap: break-word` not reducing min-content the way
 * `anywhere` does — have nothing in common except the symptom.
 */

test.use({ viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true })

const LONG = 'x'.repeat(120)
const LONG_ADDRESS = `${LONG}@example.test`

async function stub(page: Page) {
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ user: { id: 'u1', email: LONG_ADDRESS } }),
    }),
  )

  await page.route('**/api/accounts', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        accounts: [
          {
            id: 'a1',
            gmailAddress: LONG_ADDRESS,
            status: 'active',
            connectedAt: '2026-08-01T00:00:00.000Z',
            lastSyncedAt: null,
            senderName: LONG,
            sync: {
              indexed: 5,
              estimate: 10,
              backfilling: true,
              paused: false,
              lastSyncedAt: null,
              error: LONG,
            },
          },
        ],
      }),
    }),
  )

  await page.route('**/api/rules', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        rules: [
          {
            id: 'r1',
            accountId: 'a1',
            query: LONG,
            action: 'trash',
            schedule: 'weekly',
            enabled: true,
            lastRunAt: null,
            createdAt: '2026-08-01T00:00:00.000Z',
          },
        ],
      }),
    }),
  )

  await page.route('**/api/messages/analytics/last', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        activeJobId: null,
        run: {
          accountId: null,
          query: '-in:spam',
          filters: {},
          finishedAt: '2026-08-23 12:00:00',
          result: {
            total: 100,
            withAttachment: 40,
            withoutAttachment: 60,
            scanned: 100,
            truncated: false,
            accounts: [
              {
                accountId: 'a1',
                gmailAddress: LONG_ADDRESS,
                count: 100,
                withAttachment: 40,
              },
            ],
            senders: [
              {
                address: LONG_ADDRESS,
                name: LONG,
                count: 50,
                withAttachment: 5,
                byAccount: { a1: { count: 50, withAttachment: 5 } },
              },
            ],
          },
        },
      }),
    }),
  )

  await page.route('**/api/messages?**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        messages: [
          {
            gmailMessageId: 'm1',
            threadId: 't1',
            accountId: 'a1',
            gmailAddress: LONG_ADDRESS,
            from: `${LONG} <${LONG_ADDRESS}>`,
            subject: LONG,
            snippet: LONG,
            labels: ['INBOX'],
            receivedAt: '2026-08-23T10:00:00.000Z',
          },
        ],
        nextPageToken: null,
        accounts: [],
        skipped: [],
      }),
    }),
  )

  await page.route('**/api/messages/m1?**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        message: {
          id: 'm1',
          threadId: 't1',
          subject: LONG,
          from: `${LONG} <${LONG_ADDRESS}>`,
          to: LONG_ADDRESS,
          cc: '',
          date: '2026-08-23T10:00:00.000Z',
          text: LONG,
          html: null,
          attachments: [
            {
              attachmentId: 'att-1',
              filename: `${LONG}.pdf`,
              mimeType: 'application/pdf',
              size: 1000,
            },
          ],
        },
      }),
    }),
  )
}

/** The document must never be wider than the window it is displayed in. */
async function expectFits(page: Page) {
  const measured = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    inner: window.innerWidth,
  }))

  expect(measured.scrollWidth).toBeLessThanOrEqual(measured.inner)
}

test.describe('a long unbreakable string cannot widen the page', () => {
  test('in the message list', async ({ page }) => {
    await stub(page)
    await page.goto('/')
    await page.waitForSelector('.message')
    await expectFits(page)
  })

  test('in the reading pane', async ({ page }) => {
    await stub(page)
    await page.goto('/')
    await page.locator('.message__open').click()
    await page.waitForSelector('.reader')
    await expectFits(page)
  })

  test('in the analysis panel', async ({ page }) => {
    await stub(page)
    await page.goto('/')
    await page.getByRole('button', { name: 'Analyse mailbox' }).click()
    await page.waitForSelector('.analytics__senders')
    await expectFits(page)
  })

  test('in the accounts list', async ({ page }) => {
    await stub(page)
    await page.goto('/')
    await page.getByRole('button', { name: 'Menu', exact: true }).click()
    await page.getByRole('button', { name: 'Accounts' }).click()
    await page.waitForSelector('.accounts')
    await expectFits(page)
  })

  test('in the rules and indexing view', async ({ page }) => {
    await stub(page)
    await page.goto('/')
    await page.getByRole('button', { name: 'Menu', exact: true }).click()
    await page.getByRole('button', { name: 'Rules' }).click()
    await page.waitForSelector('.indexing')
    await expectFits(page)
  })

  test('in the nav drawer', async ({ page }) => {
    await stub(page)
    await page.goto('/')
    await page.getByRole('button', { name: 'Menu', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Trash' })).toBeVisible()
    await expectFits(page)
  })
})

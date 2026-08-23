import { expect, test, type Page } from '@playwright/test'

/**
 * The app on a phone.
 *
 * Three separate reports, one underlying cause each — and each of them made
 * something look broken rather than merely cramped, which is why they are
 * worth pinning down with tests rather than eyeballing once.
 */

test.use({ viewport: { width: 390, height: 780 }, hasTouch: true })

const ACCOUNT = {
  id: 'acc-1',
  gmailAddress: 'me@example.test',
  status: 'active' as const,
  connectedAt: '2026-08-01T00:00:00.000Z',
  lastSyncedAt: null,
}

const ROW = {
  gmailMessageId: 'm1',
  threadId: 't1',
  accountId: ACCOUNT.id,
  gmailAddress: ACCOUNT.gmailAddress,
  from: 'Aditya <aditya@example.test>',
  subject: 'Test message',
  snippet: 'Hello',
  labels: ['INBOX'],
  receivedAt: '2026-08-23T10:26:00.000Z',
}

async function stub(page: Page) {
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
  await page.route('**/api/messages?**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        messages: [ROW],
        nextPageToken: null,
        accounts: [
          {
            accountId: ACCOUNT.id,
            gmailAddress: ACCOUNT.gmailAddress,
            error: null,
          },
        ],
        skipped: [],
      }),
    }),
  )
  await page.route('**/api/messages/analytics/last', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ run: null, activeJobId: null }),
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
          subject: 'Test message',
          from: 'Aditya <aditya@example.test>',
          to: 'me@example.test',
          cc: '',
          date: '2026-08-23T10:26:00.000Z',
          text: 'Hello there',
          html: null,
          attachments: [],
        },
      }),
    }),
  )
}

test('the nav drawer floats over the page instead of pushing it down', async ({
  page,
}) => {
  await stub(page)
  await page.goto('/')

  const heading = page.getByRole('heading', { name: 'Inbox' })
  const before = await heading.boundingBox()

  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Trash' })).toBeVisible()

  /*
   * The whole complaint. In the flow, opening the drawer walked the content
   * off the bottom of the screen and closing it walked it back.
   */
  const after = await heading.boundingBox()
  expect(after?.y).toBeCloseTo(before?.y ?? 0, 0)
})

test('opening a message shows it, rather than putting it below the list', async ({
  page,
}) => {
  await stub(page)
  await page.goto('/')

  await page.getByRole('button', { name: /Test message/ }).click()

  /*
   * Stacked under a list that can be five hundred rows long, the reader was
   * technically rendered and thousands of pixels away — so tapping a message
   * appeared to do nothing at all.
   */
  const reader = page.locator('.reader')
  await expect(reader).toBeVisible()
  await expect(reader).toContainText('Hello there')

  const box = await reader.boundingBox()
  expect(box?.y ?? 999).toBeLessThan(780)

  // And Close stays reachable without hunting for it.
  await expect(reader.getByRole('button', { name: 'Close' })).toBeInViewport()
})

test('the analysis panel opens on a phone', async ({ page }) => {
  await stub(page)
  await page.goto('/')

  await page.getByRole('button', { name: 'Analyse mailbox' }).click()

  const panel = page.getByRole('complementary', { name: 'Mailbox analysis' })
  await expect(panel).toBeVisible()
  await expect(panel).toBeInViewport()
})

test('checkboxes stay square', async ({ page }) => {
  await stub(page)
  await page.goto('/')

  /*
   * `min-height: 44px` on every input stretched them into tall slivers: the
   * touch-target rule was written for text fields and buttons and quietly
   * applied to a 1rem square.
   */
  const box = await page
    .locator('.message input[type="checkbox"]')
    .first()
    .boundingBox()

  expect(box).not.toBeNull()
  expect(Math.abs((box?.width ?? 0) - (box?.height ?? 0))).toBeLessThan(2)
})

/*
 * Above the breakpoint every destination is already on screen, so the toggle
 * has nothing to toggle. It sat there anyway for a long time, switching its
 * own label between Menu and Close and doing nothing else, because it shared
 * a class with a rule that kept winning on specificity.
 */
test.describe('on a desktop width', () => {
  test.use({ viewport: { width: 1280, height: 900 } })

  test('there is no menu button, and the nav is simply there', async ({
    page,
  }) => {
    await stub(page)
    await page.goto('/')

    await expect(page.getByRole('button', { name: 'Trash' })).toBeVisible()
    await expect(page.locator('.app__menu')).toBeHidden()
  })
})

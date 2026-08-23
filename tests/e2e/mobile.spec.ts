import { expect, test, type Page } from '@playwright/test'

/**
 * The app on a phone.
 *
 * Three separate reports, one underlying cause each — and each of them made
 * something look broken rather than merely cramped, which is why they are
 * worth pinning down with tests rather than eyeballing once.
 */

/*
 * `isMobile` as well as `hasTouch`, and the difference matters: without it
 * Chromium still reports `pointer: fine`, so every rule in the touch-target
 * media block is inert. The checkbox test below passed for months against a
 * desktop pointer, proving nothing about the phones it was written for.
 */
test.use({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true })

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
 * Square and small is still small for a thumb. The rest of the target is a
 * transparent pseudo-element, invisible to `boundingBox` — the only way to
 * know it works is to tap where a thumb would actually land.
 *
 * Not gated on `pointer: coarse`: that does not match in headless Chromium,
 * so gating it made this test pass locally and fail in CI, which is the worst
 * of both. A forgiving checkbox is not a worse checkbox with a mouse.
 */
test('a checkbox can be tapped slightly off-centre', async ({ page }) => {
  await stub(page)
  await page.goto('/')

  const checkbox = page.locator('.message input[type="checkbox"]').first()

  /*
   * Scrolled into view first. `page.mouse.click` takes viewport coordinates
   * and, unlike `locator.click`, does not scroll to reach anything — and the
   * first message row sits below the fold on a 780px-tall phone. Without
   * this the test was clicking empty space above the list, which failed or
   * passed depending on nothing more meaningful than how tall the filter
   * panel happened to render.
   */
  await checkbox.scrollIntoViewIfNeeded()
  const box = (await checkbox.boundingBox())!

  // Eight pixels to the left of the drawn box: outside the square, inside the
  // intended target, and within the card's own padding.
  await page.mouse.click(box.x - 8, box.y + box.height / 2)
  await expect(checkbox).toBeChecked()
})

/*
 * The other half of that bargain. An invisible 44px target around a control
 * sitting next to another control can swallow its neighbour's taps, and the
 * neighbour here is the whole message row.
 */
test('the enlarged target does not steal taps from the message row', async ({
  page,
}) => {
  await stub(page)
  await page.goto('/')

  // Just inside the row's leading edge — the closest a real tap gets to the
  // checkbox while plainly meaning "open this".
  const row = page.getByRole('button', { name: /Test message/ })
  await row.click({ position: { x: 3, y: 20 } })

  await expect(page.locator('.reader')).toBeVisible()
  await expect(
    page.locator('.message input[type="checkbox"]').first(),
  ).not.toBeChecked()
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

import { expect, test, type Page } from '@playwright/test'

/**
 * Selecting more than one message.
 *
 * "Select page" and "select all matching" cover the two extremes. What was
 * missing is everything between them: a run of rows, or a handful of
 * scattered ones — which is most of what anyone actually does when clearing
 * out a mailbox by hand.
 */

/*
 * Taller than the default 720.
 *
 * A drag is driven in viewport coordinates and the pointer cannot be moved
 * past the bottom of the window — with the filter panel above the list, the
 * third row sat below the fold and every drag "stopped one short". It was the
 * window, not the feature.
 */
test.use({ viewport: { width: 1280, height: 1200 } })

const ACCOUNT = {
  id: 'acc-1',
  gmailAddress: 'me@example.test',
  status: 'active' as const,
  connectedAt: '2026-08-01T00:00:00.000Z',
  lastSyncedAt: null,
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
        messages: Array.from({ length: 6 }, (_, n) => ({
          gmailMessageId: `m${n}`,
          threadId: `t${n}`,
          accountId: ACCOUNT.id,
          gmailAddress: ACCOUNT.gmailAddress,
          from: `Sender ${n} <s${n}@example.test>`,
          subject: `Message ${n}`,
          snippet: 'preview',
          labels: ['INBOX'],
          receivedAt: new Date(Date.UTC(2026, 7, 20, 12, 30 - n)).toISOString(),
        })),
        nextPageToken: null,
        accounts: [],
        skipped: [],
      }),
    }),
  )
}

const boxes = (page: Page) => page.locator('.message input[type="checkbox"]')

async function checkedCount(page: Page): Promise<number> {
  return page.locator('.message input[type="checkbox"]:checked').count()
}

test.describe('selecting a run of messages', () => {
  test('shift-click selects everything between', async ({ page }) => {
    await stub(page)
    await page.goto('/')

    await boxes(page).nth(1).click()
    await boxes(page).nth(4).click({ modifiers: ['Shift'] })

    // 1 through 4 inclusive, and nothing outside it.
    expect(await checkedCount(page)).toBe(4)
    await expect(boxes(page).nth(0)).not.toBeChecked()
    await expect(boxes(page).nth(5)).not.toBeChecked()
  })

  /*
   * A range takes the sense of the row it started from, so shift-clicking
   * inside a selected block clears the block rather than re-selecting what is
   * already selected.
   */
  test('shift-click deselects when the anchor was already off', async ({
    page,
  }) => {
    await stub(page)
    await page.goto('/')

    await page.getByLabel(/Select page/).check()
    expect(await checkedCount(page)).toBe(6)

    await boxes(page).nth(1).click()
    await boxes(page).nth(3).click({ modifiers: ['Shift'] })

    // Rows 1..3 turned off; 0, 4 and 5 untouched.
    expect(await checkedCount(page)).toBe(3)
    await expect(boxes(page).nth(2)).not.toBeChecked()
  })

  test('dragging across the boxes selects what it passes', async ({ page }) => {
    await stub(page)
    await page.goto('/')

    // A drag begins on a checkbox and then follows the pointer down the list,
    // not from tick to tick.
    const start = (await boxes(page).nth(0).boundingBox())!
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2)
    await page.mouse.down()

    /*
     * Measured *after* the drag has begun.
     *
     * Ticking the first row makes the bulk-action bar appear above the list,
     * which pushes every row down. Coordinates taken beforehand then point a
     * row higher than intended, and this test spent a while insisting the
     * drag stopped one short when it was the ruler that had moved.
     */
    for (const row of [1, 2]) {
      const box = (await page.locator('.message').nth(row).boundingBox())!
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
        steps: 6,
      })
    }

    await page.mouse.up()

    expect(await checkedCount(page)).toBe(3)
  })

  test('Ctrl+A takes the page, and again gives it back', async ({ page }) => {
    await stub(page)
    await page.goto('/')

    await page.locator('.messages').click({ position: { x: 2, y: 2 } })
    await page.keyboard.press('Control+a')
    expect(await checkedCount(page)).toBe(6)

    await page.keyboard.press('Control+a')
    expect(await checkedCount(page)).toBe(0)
  })

  /*
   * Where Ctrl+A obviously means "the text I am typing" it has to keep meaning
   * that — the shortcut is a convenience, not a claim on the keyboard.
   */
  test('Ctrl+A in a text field is left alone', async ({ page }) => {
    await stub(page)
    await page.goto('/')

    await page.getByPlaceholder('Search words in subject or body').fill('hello')
    await page.keyboard.press('Control+a')

    expect(await checkedCount(page)).toBe(0)
  })
})

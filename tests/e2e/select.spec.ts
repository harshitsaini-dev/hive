import { expect, test, type Page } from '@playwright/test'

/**
 * The custom dropdown.
 *
 * It replaced a native `<select>`, which is a trade worth being careful
 * about: the native element gives keyboard handling, screen-reader semantics
 * and click-away for free, and all of that had to be rebuilt by hand. These
 * tests are the check that nothing was lost in exchange for the styling.
 */

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
      body: JSON.stringify({
        accounts: [
          {
            id: 'acc-1',
            gmailAddress: 'tester@example.test',
            status: 'active',
            connectedAt: '2026-08-01T00:00:00.000Z',
            lastSyncedAt: null,
          },
        ],
      }),
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
}

test.describe('dropdown', () => {
  test.beforeEach(async ({ page }) => {
    await stub(page)
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Inbox', level: 1 })).toBeVisible()
  })

  test('announces itself as a listbox', async ({ page }) => {
    const trigger = page.getByRole('button', { name: 'Age' })

    await expect(trigger).toHaveAttribute('aria-haspopup', 'listbox')
    await expect(trigger).toHaveAttribute('aria-expanded', 'false')

    await trigger.click()

    await expect(trigger).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByRole('listbox', { name: 'Age' })).toBeVisible()
    // The current choice is marked, not merely highlighted.
    await expect(page.getByRole('option', { name: 'Any age' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  })

  test('picks an option with the mouse', async ({ page }) => {
    const trigger = page.getByRole('button', { name: 'Age' })

    await trigger.click()
    await page.getByRole('option', { name: 'Older than a month' }).click()

    await expect(trigger).toContainText('Older than a month')
    await expect(page.getByRole('listbox')).toBeHidden()
  })

  test('is fully operable from the keyboard', async ({ page }) => {
    const trigger = page.getByRole('button', { name: 'Age' })

    await trigger.focus()
    // The native control opens on ArrowDown, so this one must too.
    await page.keyboard.press('ArrowDown')
    await expect(page.getByRole('listbox', { name: 'Age' })).toBeVisible()

    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')

    await expect(trigger).toContainText('Older than a week')
  })

  test('Escape closes it without changing the value', async ({ page }) => {
    const trigger = page.getByRole('button', { name: 'Age' })

    await trigger.click()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Escape')

    await expect(page.getByRole('listbox')).toBeHidden()
    // Moving the highlight is not choosing.
    await expect(trigger).toContainText('Any age')
  })

  test('clicking away closes it', async ({ page }) => {
    await page.getByRole('button', { name: 'Age' }).click()
    await expect(page.getByRole('listbox')).toBeVisible()

    await page.getByRole('heading', { name: 'Inbox', level: 1 }).click()
    await expect(page.getByRole('listbox')).toBeHidden()
  })

  test('End and Home jump to the ends of the list', async ({ page }) => {
    const trigger = page.getByRole('button', { name: 'Age' })

    await trigger.click()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await expect(trigger).toContainText('Older than a year')

    await trigger.click()
    await page.keyboard.press('Home')
    await page.keyboard.press('Enter')
    await expect(trigger).toContainText('Any age')
  })
})

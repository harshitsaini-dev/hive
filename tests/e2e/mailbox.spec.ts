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
}

async function stubApi(page: Page): Promise<Calls> {
  const calls: Calls = {
    trash: 0,
    restore: 0,
    deleteForever: 0,
    lastDeletePayload: null,
    lastTrashPayload: null,
    resolveCalls: 0,
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

    const search = page.getByRole('searchbox', { name: 'Search mail' })
    await expect(search).toHaveAttribute('placeholder', /older_than|from:/)
    await expect(page.getByText(/has:attachment/)).toBeVisible()
  })

  test('selecting mail reveals bulk actions', async ({ page }) => {
    await expect(page.getByText(/selected/)).toBeHidden()

    await page.getByLabel(/Select all 3/).check()

    await expect(page.getByText('3 selected on this page')).toBeVisible()
    await expect(page.getByRole('button', { name: /Move \d+ to Trash/ })).toBeVisible()
    // Permanent deletion is not offered from the inbox at all.
    await expect(page.getByRole('button', { name: /Delete \d+ forever/ })).toBeHidden()
  })

  test('the Trash tab offers restore and delete forever', async ({ page }) => {
    await page.getByRole('button', { name: 'Trash' }).click()
    await page.getByLabel(/Select all 3/).check()

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
    await page.getByLabel(/Select all 3/).check()
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
    await page.getByLabel(/Select all 3/).check()

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
    await page.getByLabel(/Select all 3/).check()
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
    await page.getByLabel(/Select all 3/).check()
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
  test('is only offered once the page is fully selected', async ({ page }) => {
    await stubApi(page)
    await page.goto('/')

    const expand = page.getByRole('button', {
      name: /Select everything matching this search/,
    })

    // One message ticked is not a signal that someone wants all of them.
    await page.locator('.message input[type="checkbox"]').first().check()
    await expect(expand).toBeHidden()

    await page.getByLabel(/Select all 3/).check()
    await expect(expand).toBeVisible()
  })

  test('acts on every match, not just the visible page', async ({ page }) => {
    const calls = await stubApi(page)
    await page.goto('/')

    await page.getByLabel(/Select all 3/).check()
    await page
      .getByRole('button', { name: /Select everything matching this search/ })
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

    await page.getByLabel(/Select all 3/).check()
    await page
      .getByRole('button', { name: /Select everything matching this search/ })
      .click()
    await expect(page.getByText(/137 selected/)).toBeVisible()

    await page.getByRole('button', { name: 'Just this page instead' }).click()
    await expect(page.getByText(/3 selected on this page/)).toBeVisible()

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
    await page.getByLabel(/Select all 3/).check()
    await page
      .getByRole('button', { name: /Select everything matching this search/ })
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
    await page.getByLabel(/Select all 3/).check()
    await page
      .getByRole('button', { name: /Select everything matching this search/ })
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

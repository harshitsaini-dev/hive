import { expect, test, type Page } from '@playwright/test'

/**
 * Choosing mailboxes and senders, when there are forty of one and thousands
 * of the other.
 *
 * A plain dropdown was fine at three accounts and useless at forty: a list you
 * scroll blindly, one choice at a time, when the question people actually have
 * is "these five". So the pickers search, and they take more than one answer.
 *
 * The sender list is worth its own care. A cleanup rule runs unattended
 * against a query written weeks earlier, and an address typed from memory is
 * how that query quietly matches nothing for ever. Picking from what the index
 * has actually seen removes the typo as a possibility.
 */

const ACCOUNTS = Array.from({ length: 24 }, (_, n) => ({
  id: `a${n}`,
  gmailAddress:
    n === 3 ? 'rajmandir.nangloi@example.test' : `mailbox.${n}@example.test`,
  status: 'active' as const,
  connectedAt: '2026-08-01T00:00:00.000Z',
  lastSyncedAt: null,
}))

interface Seen {
  searches: URLSearchParams[]
  analyses: Record<string, unknown>[]
  rules: Record<string, unknown>[]
  senderQueries: string[]
}

async function stub(page: Page): Promise<Seen> {
  const seen: Seen = { searches: [], analyses: [], rules: [], senderQueries: [] }

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

  await page.route('**/api/rules', (route) => {
    if (route.request().method() === 'POST') {
      seen.rules.push(route.request().postDataJSON())
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ rule: { id: `r${seen.rules.length}` } }),
      })
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ rules: [] }),
    })
  })

  await page.route('**/api/messages/senders**', (route) => {
    seen.senderQueries.push(new URL(route.request().url()).search)
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        senders: [
          { address: 'billing@vendor.test', count: 812 },
          { address: 'newsletter@shop.test', count: 240 },
          { address: 'alerts@bank.test', count: 96 },
        ],
      }),
    })
  })

  await page.route('**/api/messages/analytics/last', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ run: null, activeJobId: null }),
    }),
  )

  await page.route('**/api/messages/analytics', (route) => {
    seen.analyses.push(route.request().postDataJSON())
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jobId: 'job-1' }),
    })
  })

  await page.route('**/api/messages/jobs/job-1', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'job-1',
        action: 'analyze',
        total: 1,
        processed: 1,
        status: 'done',
        error: null,
        result: {
          total: 1,
          withAttachment: 0,
          withoutAttachment: 1,
          scanned: 1,
          truncated: false,
          accounts: [],
          senders: [],
        },
      }),
    }),
  )

  await page.route('**/api/messages/resolve-query', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        messageIds: ['x'],
        count: 12,
        truncated: false,
        limit: 10_000,
      }),
    }),
  )

  await page.route('**/api/messages?**', (route) => {
    seen.searches.push(new URL(route.request().url()).searchParams)
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

  return seen
}

const lastSearch = (seen: Seen) =>
  seen.searches[seen.searches.length - 1] ?? new URLSearchParams()

const chosenCount = (seen: Seen) =>
  lastSearch(seen).get('accountIds')?.split(',').length ?? 0

test.describe('picking mailboxes', () => {
  test('the mail filters take several, found by typing', async ({ page }) => {
    const seen = await stub(page)
    await page.goto('/')

    await page.getByRole('button', { name: 'Accounts to search' }).click()
    const panel = page.getByRole('dialog', { name: 'Accounts to search' })

    // Twenty-four rows, narrowed to one by typing part of the address.
    await panel.getByPlaceholder('Find a mailbox').fill('nangloi')
    await expect(panel.getByRole('checkbox')).toHaveCount(1)
    await panel.getByRole('checkbox').check()
    await expect.poll(() => lastSearch(seen).get('accountIds')).toBe('a3')

    await panel.getByPlaceholder('Find a mailbox').fill('mailbox.10@')
    await panel.getByRole('checkbox').check()
    await expect.poll(() => chosenCount(seen)).toBe(2)
  })

  /*
   * Empty means all of them — the convention the rest of the app already
   * uses for an unset account filter, and the reason the common case is a
   * single glance rather than twenty-four ticks.
   */
  test('clearing the choice searches every mailbox again', async ({ page }) => {
    const seen = await stub(page)
    await page.goto('/')

    await page.getByRole('button', { name: 'Accounts to search' }).click()
    const panel = page.getByRole('dialog', { name: 'Accounts to search' })

    await panel.getByPlaceholder('Find a mailbox').fill('nangloi')
    await panel.getByRole('checkbox').check()
    await expect.poll(() => lastSearch(seen).get('accountIds')).toBe('a3')

    await panel.getByRole('button', { name: 'All accounts' }).click()
    await expect.poll(() => lastSearch(seen).get('accountIds')).toBeNull()
  })

  test('everything a search matches can be added at once', async ({ page }) => {
    const seen = await stub(page)
    await page.goto('/')

    await page.getByRole('button', { name: 'Accounts to search' }).click()
    const panel = page.getByRole('dialog', { name: 'Accounts to search' })

    await panel.getByPlaceholder('Find a mailbox').fill('mailbox.2')
    await panel.getByRole('button', { name: /Add these/ }).click()

    // mailbox.2 and .20 through .23 — five, and not one tick each.
    await expect.poll(() => chosenCount(seen)).toBe(5)
  })

  test('the analysis is scoped by the same picker', async ({ page }) => {
    const seen = await stub(page)
    await page.goto('/')
    await page.getByRole('button', { name: 'Analyse mailbox' }).click()

    const analysis = page.getByRole('complementary', {
      name: 'Mailbox analysis',
    })
    await analysis.getByRole('button', { name: 'Accounts to analyse' }).click()

    const panel = page.getByRole('dialog', { name: 'Accounts to analyse' })
    await panel.getByPlaceholder('Find a mailbox').fill('nangloi')
    await panel.getByRole('checkbox').check()
    await page.keyboard.press('Escape')

    await analysis.getByRole('button', { name: 'Analyse', exact: true }).click()
    await expect.poll(() => seen.analyses.at(-1)).toMatchObject({
      accountIds: ['a3'],
    })
  })
})

test.describe('cleanup rules across mailboxes and senders', () => {
  async function openRules(page: Page) {
    await page.goto('/')
    await page.getByRole('button', { name: 'Rules' }).click()
    return page.locator('.wizard')
  }

  test('saves one rule per mailbox, senders folded into the query', async ({
    page,
  }) => {
    const seen = await stub(page)
    const wizard = await openRules(page)

    await wizard
      .getByRole('button', { name: 'Mailboxes this rule covers' })
      .click()
    const picker = page.getByRole('dialog', {
      name: 'Mailboxes this rule covers',
    })
    // a0 is already chosen; add a second so the fan-out is visible.
    await picker.getByPlaceholder('Find a mailbox').fill('mailbox.1@')
    await picker.getByRole('checkbox').check()
    await page.keyboard.press('Escape')

    await wizard.getByRole('button', { name: 'Senders this rule covers' }).click()
    const senders = page.getByRole('dialog', { name: 'Senders this rule covers' })
    await senders.getByText('billing@vendor.test').click()
    await senders.getByText('alerts@bank.test').click()
    await page.keyboard.press('Escape')

    await wizard.getByRole('button', { name: 'Check what this matches' }).click()
    await wizard.getByRole('button', { name: /Looks right/ }).click()
    await wizard.getByRole('button', { name: 'Save rule' }).click()

    /*
     * Two mailboxes means two rules. A rule row holds one account, and a rule
     * that is really several should be several — pausable and auditable
     * apiece, rather than one row that quietly acts in two places.
     */
    await expect.poll(() => seen.rules.length).toBe(2)
    expect(seen.rules.map((rule) => rule.accountId).sort()).toEqual(['a0', 'a1'])
    for (const rule of seen.rules) {
      expect(rule.query).toBe('from:(billing@vendor.test OR alerts@bank.test)')
      // Rules trash. They never delete, whatever they were built from.
      expect(JSON.stringify(rule)).not.toContain('delete')
    }
  })

  test('the sender list is asked for the chosen mailboxes', async ({ page }) => {
    const seen = await stub(page)
    const wizard = await openRules(page)

    await wizard.getByRole('button', { name: 'Senders this rule covers' }).click()
    await expect.poll(() => seen.senderQueries.at(-1)).toContain('accountIds=a0')

    // Sender counts come from the index, so the list is worth reading.
    await expect(page.getByText('812')).toBeVisible()
  })

  test('a sender alone is condition enough to save', async ({ page }) => {
    const seen = await stub(page)
    const wizard = await openRules(page)

    await wizard.getByRole('button', { name: 'Senders this rule covers' }).click()
    await page
      .getByRole('dialog', { name: 'Senders this rule covers' })
      .getByText('newsletter@shop.test')
      .click()
    await page.keyboard.press('Escape')

    // The warning about a rule matching the whole mailbox should be gone.
    await expect(
      wizard.getByText('Choose at least one filter or sender'),
    ).toBeHidden()

    await wizard.getByRole('button', { name: 'Check what this matches' }).click()
    await wizard.getByRole('button', { name: /Looks right/ }).click()
    await wizard.getByRole('button', { name: 'Save rule' }).click()

    await expect.poll(() => seen.rules.at(-1)).toMatchObject({
      query: 'from:newsletter@shop.test',
    })
  })
})

test.describe('the rules page', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('puts the cleanup rules on the right of the index', async ({ page }) => {
    await stub(page)
    await page.goto('/')
    await page.getByRole('button', { name: 'Rules' }).click()
    await page.waitForSelector('.rulesgrid__rules')

    const rules = (await page.locator('.rulesgrid__rules').boundingBox())!
    const index = (await page.locator('.rulesgrid__index').boundingBox())!

    expect(rules.x).toBeGreaterThan(index.x)
    // Side by side rather than stacked, so neither card buries the other.
    expect(Math.abs(rules.y - index.y)).toBeLessThan(20)
  })
})

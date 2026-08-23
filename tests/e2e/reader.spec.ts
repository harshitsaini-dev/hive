import { expect, test, type Page } from '@playwright/test'

/**
 * The reading pane, and the pictures in it.
 *
 * Reported: an emailed photo showed as a filename and a broken-image icon.
 * Two separate causes behind one symptom — attachments were only ever offered
 * as downloads, and a body that embeds its image with `src="cid:…"` points at
 * something the frame cannot resolve on its own.
 *
 * The rules being protected here are security rules as much as display ones:
 * only raster images render, only same-origin sources are allowed into the
 * frame, and a remote image stays blocked because loading one tells the
 * sender the message was opened.
 */

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
  subject: 'Test',
  snippet: 'Hello how are you ?',
  labels: ['INBOX'],
  receivedAt: '2026-08-23T10:26:00.000Z',
}

/** A one-pixel PNG, so the served bytes are genuinely a PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

interface Seen {
  attachmentUrls: string[]
}

async function stub(page: Page, message: Record<string, unknown>): Promise<Seen> {
  const seen: Seen = { attachmentUrls: [] }

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

  // Ordered before the message route so it wins for attachment paths.
  await page.route('**/api/messages/*/attachments/**', (route) => {
    seen.attachmentUrls.push(new URL(route.request().url()).search)
    route.fulfill({
      status: 200,
      contentType: 'image/png',
      headers: { 'Content-Disposition': 'inline; filename="photo.jpeg"' },
      body: PNG,
    })
  })

  await page.route('**/api/messages/m1?**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ message }),
    }),
  )

  return seen
}

function baseMessage(overrides: Record<string, unknown>) {
  return {
    id: 'm1',
    threadId: 't1',
    subject: 'Test',
    from: 'Aditya <aditya@example.test>',
    to: 'me@example.test',
    cc: '',
    date: '2026-08-23T10:26:00.000Z',
    text: 'Hello how are you ?',
    html: null,
    attachments: [],
    ...overrides,
  }
}

async function openMessage(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: /Test/ }).first().click()
}

test.describe('attachments in the reading pane', () => {
  test('shows an image attachment as a picture, not a filename', async ({
    page,
  }) => {
    const seen = await stub(
      page,
      baseMessage({
        attachments: [
          {
            attachmentId: 'att-1',
            filename: 'photo.jpeg',
            mimeType: 'image/jpeg',
            size: 2_400_000,
          },
        ],
      }),
    )

    await openMessage(page)

    const thumb = page.locator('.reader__thumb')
    await expect(thumb).toBeVisible()

    // Rendered, not merely present: a broken image has no intrinsic width.
    await expect
      .poll(() => thumb.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(0)

    // The filename is still there to download, alongside the picture.
    await expect(
      page.getByRole('link', { name: 'photo.jpeg' }),
    ).toBeVisible()

    expect(seen.attachmentUrls.some((url) => url.includes('inline=1'))).toBe(
      true,
    )
  })

  test('a non-image attachment stays a plain download', async ({ page }) => {
    await stub(
      page,
      baseMessage({
        attachments: [
          {
            attachmentId: 'att-1',
            filename: 'invoice.pdf',
            mimeType: 'application/pdf',
            size: 12_000,
          },
        ],
      }),
    )

    await openMessage(page)

    await expect(page.getByRole('link', { name: 'invoice.pdf' })).toBeVisible()
    await expect(page.locator('.reader__thumb')).toHaveCount(0)
  })

  /*
   * An SVG is an image and is deliberately excluded: it is a document that
   * can carry script, and rendering one in this origin would run it with the
   * session's cookies.
   */
  test('an SVG is never rendered, whatever it is labelled', async ({ page }) => {
    await stub(
      page,
      baseMessage({
        attachments: [
          {
            attachmentId: 'att-1',
            filename: 'logo.svg',
            mimeType: 'image/svg+xml',
            size: 900,
          },
        ],
      }),
    )

    await openMessage(page)

    await expect(page.getByRole('link', { name: 'logo.svg' })).toBeVisible()
    await expect(page.locator('.reader__thumb')).toHaveCount(0)
  })
})

test.describe('images embedded in the body', () => {
  test('resolves a cid: reference to the attachment behind it', async ({
    page,
  }) => {
    await stub(
      page,
      baseMessage({
        text: null,
        html: '<p>Hello</p><img src="cid:ii_abc123" alt="embedded">',
        attachments: [
          {
            attachmentId: 'att-1',
            filename: 'photo.jpeg',
            mimeType: 'image/jpeg',
            size: 2_400_000,
            contentId: 'ii_abc123',
          },
        ],
      }),
    )

    await openMessage(page)

    const frame = page.frameLocator('.reader__frame')
    const embedded = frame.locator('img[alt="embedded"]')

    // The src was rewritten to the attachment endpoint, and it loaded.
    await expect(embedded).toHaveAttribute('src', /attachments\/att-1/)
    await expect
      .poll(() => embedded.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(0)
  })

  test('a cid: with nothing behind it is left alone', async ({ page }) => {
    await stub(
      page,
      baseMessage({
        text: null,
        html: '<img src="cid:missing" alt="embedded">',
        attachments: [],
      }),
    )

    await openMessage(page)

    const embedded = page.frameLocator('.reader__frame').locator('img')
    await expect(embedded).toHaveAttribute('src', 'cid:missing')
  })

  /*
   * The tracking pixel this app refuses to fire. Rewriting `cid:` must not
   * turn into rewriting everything — a remote image loading is what tells the
   * sender the message was opened.
   */
  test('a remote image is not rewritten and does not load', async ({ page }) => {
    let requested = false
    await page.route('https://tracker.example.test/**', (route) => {
      requested = true
      route.fulfill({ status: 200, contentType: 'image/png', body: PNG })
    })

    await stub(
      page,
      baseMessage({
        text: null,
        html: '<img src="https://tracker.example.test/pixel.png" alt="pixel">',
        attachments: [],
      }),
    )

    await openMessage(page)

    const pixel = page.frameLocator('.reader__frame').locator('img')
    await expect(pixel).toHaveAttribute(
      'src',
      'https://tracker.example.test/pixel.png',
    )
    expect(requested).toBe(false)
  })
})

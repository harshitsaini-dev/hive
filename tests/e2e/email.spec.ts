import { expect, test } from '@playwright/test'
import { renderOtpEmail, OTP_TTL_MINUTES } from '../../apps/server/src/emails/otp.js'

/**
 * The login email.
 *
 * Worth testing carefully despite being "just a template": it is the only way
 * anyone gets into the product. If it renders badly, lands in spam, or shows
 * the wrong expiry, nobody can sign in — and the failure is invisible from
 * inside the app.
 */
const CODE = '482913'

test.describe('login email content', () => {
  const email = renderOtpEmail(CODE, OTP_TTL_MINUTES)

  test('leads with the code so it is readable from a notification', () => {
    // Phone lock screens truncate hard. Code first means no need to open it.
    expect(email.subject.startsWith(CODE)).toBe(true)
    expect(email.subject).toContain('Hive')
  })

  test('always carries a plain-text alternative', () => {
    // A message with no text part scores worse with spam filters, and this is
    // the one email that must never be filtered.
    expect(email.text.length).toBeGreaterThan(50)
    expect(email.text).not.toContain('<')
    expect(email.text).toContain('482 913')
  })

  test('states the expiry the server actually enforces', () => {
    // The template takes the TTL as an argument rather than hard-coding it,
    // so this catches the two drifting apart.
    expect(email.html).toContain(`${OTP_TTL_MINUTES} minutes`)
    expect(email.text).toContain(`${OTP_TTL_MINUTES} minutes`)
  })

  test('warns that Hive will never ask for the code', () => {
    // The standard defence against someone being talked into reading it out.
    //
    // Whitespace-collapsed before matching: the phrase wraps across lines in
    // the HTML source, and asserting on the source layout would make this
    // fail on reformatting rather than on the warning actually going missing.
    const collapse = (value: string) => value.replace(/\s+/g, ' ')

    expect(collapse(email.html)).toMatch(/never ask you for it/i)
    expect(collapse(email.text)).toMatch(/never ask you for it/i)
  })

  test('loads no remote content', () => {
    // Clients block remote images by default, and a login email that renders
    // as broken boxes gets reported as phishing.
    expect(email.html).not.toMatch(/<img/i)
    expect(email.html).not.toMatch(/https?:\/\/[^"']*\.(png|jpe?g|gif|svg|webp)/i)
  })
})

test.describe('login email rendering', () => {
  test('shows the code and survives dark mode', async ({ page }) => {
    const { html } = renderOtpEmail(CODE, OTP_TTL_MINUTES)

    await page.setContent(html)

    const code = page.getByText('482 913')
    await expect(code).toBeVisible()

    /*
     * Contrast is the thing that actually breaks in email dark mode: clients
     * swap the background but leave inline colours alone. Assert the code is
     * not rendered as the same colour as what is behind it.
     */
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme })

      const [colour, background] = await code.evaluate((el) => {
        const style = getComputedStyle(el)
        const box = (el.closest('td') ?? el) as HTMLElement
        return [style.color, getComputedStyle(box).backgroundColor]
      })

      expect(colour, `code colour in ${scheme}`).not.toBe(background)
    }
  })

  test('fits a narrow phone without horizontal scroll', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 })
    await page.setContent(renderOtpEmail(CODE, OTP_TTL_MINUTES).html)

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    )
    expect(overflow, 'email overflows a 320px screen').toBeLessThanOrEqual(0)

    await expect(page.getByText('482 913')).toBeVisible()
  })
})

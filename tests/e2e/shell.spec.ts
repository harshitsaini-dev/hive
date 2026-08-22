import { expect, test } from '@playwright/test'

/**
 * Browser-visible checks on the signed-out shell.
 *
 * Split out from smoke.spec.ts because those are API assertions that never
 * open a window. These are the ones worth watching in a headed run.
 */
test.describe('login page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('offers a passwordless sign-in form', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Hive', level: 1 })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()

    const email = page.getByLabel('Email address')
    await expect(email).toBeVisible()

    // The submit button stays disabled until there is something to submit.
    const submit = page.getByRole('button', { name: 'Send me a code' })
    await expect(submit).toBeDisabled()

    await email.fill('someone@example.test')
    await expect(submit).toBeEnabled()
  })

  test('moves to the code step and can go back', async ({ page }) => {
    await page.getByLabel('Email address').fill('shell-test@example.test')
    await page.getByRole('button', { name: 'Send me a code' }).click()

    await expect(page.getByRole('heading', { name: 'Enter your code' })).toBeVisible()
    await expect(page.getByText(/shell-test@example\.test/)).toBeVisible()

    const code = page.getByLabel('Six-digit code')
    await expect(code).toBeFocused()

    // Non-digits are stripped and the field is capped at six characters.
    await code.fill('')
    await code.pressSequentially('12ab34xy567')
    await expect(code).toHaveValue('123456')

    await page.getByRole('button', { name: 'Use a different email' }).click()
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  })

  test('holds its layout from mobile to desktop', async ({ page }) => {
    const heading = page.getByRole('heading', { name: 'Hive', level: 1 })

    for (const [label, width, height] of [
      ['mobile', 375, 667],
      ['tablet', 768, 1024],
      ['laptop', 1280, 800],
      ['desktop', 1920, 1080],
    ] as const) {
      await test.step(`${label} — ${width}px`, async () => {
        await page.setViewportSize({ width, height })

        await expect(heading).toBeVisible()
        await expect(page.getByLabel('Email address')).toBeVisible()

        // Nothing may push the page wider than the viewport. This is the
        // failure that headless runs and desktop-only development both miss.
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        )
        expect(overflow, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(0)
      })
    }
  })

  test('is operable by keyboard alone', async ({ page }) => {
    await expect(page).toHaveTitle(/Hive/)
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
    await expect(page.getByRole('main')).toBeVisible()

    // Tab reaches the email field, and typing plus Enter submits the form —
    // no mouse involved anywhere in the primary path.
    await page.keyboard.press('Tab')
    await expect(page.getByLabel('Email address')).toBeFocused()

    await page.keyboard.type('keyboard@example.test')
    await page.keyboard.press('Enter')

    await expect(page.getByRole('heading', { name: 'Enter your code' })).toBeVisible()
  })
})

test.describe('signed in', () => {
  test('a full login lands on the accounts page', async ({ page, request }) => {
    const email = `ui-login-${Date.now()}@example.test`

    await page.goto('/')
    await page.getByLabel('Email address').fill(email)
    await page.getByRole('button', { name: 'Send me a code' }).click()

    await expect(page.getByRole('heading', { name: 'Enter your code' })).toBeVisible()

    const codeResponse = await request.get(
      `http://localhost:3000/auth/test/last-code?email=${encodeURIComponent(email)}`,
    )
    const { code } = (await codeResponse.json()) as { code: string }

    await page.getByLabel('Six-digit code').fill(code)
    await page.getByRole('button', { name: 'Sign in' }).click()

    await expect(page.getByRole('heading', { name: 'Connected accounts' })).toBeVisible()
    await expect(page.getByText(email)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Connect Gmail' })).toBeVisible()

    // Nothing is connected yet, so the empty state must say so rather than
    // showing an empty box.
    await expect(page.getByText(/No accounts yet/)).toBeVisible()

    // The session survives a reload — this is what proves the cookie is set
    // properly rather than the state living only in React.
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Connected accounts' })).toBeVisible()

    await page.getByRole('button', { name: 'Sign out' }).click()
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  })
})

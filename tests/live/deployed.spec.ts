import { expect, test } from '@playwright/test'

test('the deployed landing page works', async ({ page }) => {
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error' && !/401/.test(m.text())) errors.push(m.text())
  })
  page.on('pageerror', (e) => errors.push(e.message))

  await page.goto('/')
  await expect(
    page.getByRole('heading', { name: /Manage several Gmail accounts/, level: 1 }),
  ).toBeVisible()

  await page.getByRole('radio', { name: 'Dark' }).check()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')

  await page.getByRole('button', { name: 'Get started' }).click()
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()

  expect(errors, 'no unexpected console errors on the live site').toEqual([])
})

test('the deployed 404 screen renders', async ({ page }) => {
  await page.goto('/definitely-not-a-page')
  await expect(page.getByText('404')).toBeVisible()
})

test('the deployed privacy page is reachable', async ({ page }) => {
  await page.goto('/privacy')
  await expect(page.getByRole('heading', { name: 'Privacy', level: 1 })).toBeVisible()
  await expect(page.getByText('https://mail.google.com/', { exact: true })).toBeVisible()
})

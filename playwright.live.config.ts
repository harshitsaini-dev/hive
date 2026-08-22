import { defineConfig, devices } from '@playwright/test'

/**
 * Smoke tests against the deployed site.
 *
 * Separate from playwright.config.ts because that one starts local servers —
 * this deliberately starts nothing and drives whatever is live. Serving the
 * right files is not the same as the bundle actually running, and only a real
 * browser tells you which one you have.
 *
 * Override the target for a preview deployment:
 *   HIVE_LIVE_URL=https://... npm run test:live
 */
export default defineConfig({
  testDir: './tests/live',
  reporter: [['line']],
  use: {
    baseURL: process.env.HIVE_LIVE_URL ?? 'https://hive-ten-lake.vercel.app',
    headless: true,
    ...devices['Desktop Chrome'],
  },
})

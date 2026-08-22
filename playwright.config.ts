import { defineConfig, devices } from '@playwright/test'

const isCI = !!process.env.CI

/**
 * Headed runs finish in a few seconds, which is too fast to actually watch.
 * A small delay between actions makes the run followable without meaningfully
 * slowing the suite. Override with SLOWMO=0 to turn it off, or a larger number
 * when demonstrating a flow.
 */
const slowMo = isCI ? 0 : Number(process.env.SLOWMO ?? 400)

export default defineConfig({
  testDir: './tests/e2e',
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  // Serial locally so a headed run is actually watchable; parallel in CI.
  workers: isCI ? 2 : 1,
  fullyParallel: isCI,
  reporter: isCI ? [['github'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: 'https://localhost:5173',
    // The local CA is not in the browser profile Playwright spawns.
    ignoreHTTPSErrors: true,
    // Headed locally by project rule — headless passes hide layout and
    // overlay failures. See docs/06-testing.md.
    headless: isCI,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: isCI ? 'retain-on-failure' : 'off',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          slowMo,
          // ignoreHTTPSErrors alone is not enough for service workers: Chrome
          // only treats an origin as a secure context when the certificate is
          // actually trusted, and refuses to register a worker otherwise.
          args: ['--ignore-certificate-errors'],
        },
      },
    },
  ],

  webServer: [
    {
      command: 'npm run dev:server',
      url: 'https://localhost:3000/health',
      ignoreHTTPSErrors: true,
      reuseExistingServer: !isCI,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'npm run dev:web',
      url: 'https://localhost:5173',
      ignoreHTTPSErrors: true,
      reuseExistingServer: !isCI,
      timeout: 60_000,
    },
  ],
})

# Testing conventions

## Playwright runs headed locally, headless in CI

This is a project rule, not a preference. Seeing the browser catches whole
classes of problems — layout collapse, a modal opening behind an overlay, a
redirect that flashes past — that a headless pass reports as green.

`playwright.config.ts`:

```ts
import { defineConfig, devices } from '@playwright/test'

const isCI = !!process.env.CI

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: !isCI ? false : true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  workers: isCI ? 2 : 1,
  reporter: isCI ? [['github'], ['html']] : [['list'], ['html']],
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:5173',
    headless: isCI,            // headed locally — the project rule
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: isCI ? 'retain-on-failure' : 'off',
  },
  projects: [
    { name: 'setup', testMatch: /.*\.setup\.ts/ },
    {
      name: 'chromium',
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: '.auth/user.json' },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !isCI,
  },
})
```

Locally, `slowMo` helps when you are actually watching a flow:
```bash
npx playwright test --headed --project=chromium
npx playwright test --debug        # step through
npx playwright test --ui           # time-travel runner
```

## What must be covered

Per `CLAUDE.md`, non-negotiable:

- **Every route that trashes or sends** asserts an `audit_log` row was written
  with the right `action`, `user_id` and `account_id`. A UI assertion alone is
  not enough — the audit trail is the compliance surface.
- **Auth boundaries** — anonymous, wrong-user, and correct-user against every
  account-scoped route. Assert 401 vs 403 distinctly, and assert the UI never
  renders a control the user cannot use.
- **Bulk trash progress** — the WebSocket progress path with a batch large
  enough to span multiple `batchModify` calls (>1000 IDs).
- **`reauth_required`** — an account in that state surfaces clearly and does
  not silently fail syncs.

## Test data isolation

Never point tests at a real inbox you care about. Use a dedicated Gmail test
account added as an OAuth test user, and seed/tear down `message_index` rows
per test rather than sharing state between specs.

## Never commit
`.auth/` (storage state contains a real session), `test-results/`,
`playwright-report/`. All already in `.gitignore`.

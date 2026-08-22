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

## Watching the tests run

```bash
npm run test:e2e          # headed — a real browser window, this is the default
npm run test:e2e:ui       # the GUI runner: watch mode, time travel, DOM picker
npm run test:e2e:debug    # step through one action at a time
npm run test:e2e:headless # what CI runs, for a quick check
npm run test:e2e:report   # open the HTML report from the last run
```

`test:e2e:ui` is the one to reach for when you actually want to *see* what is
happening. It opens Playwright's own interface with the test list on the left
and a timeline you can scrub — hover any step and it shows the page as it was
at that moment, with the locator highlighted. It re-runs on save, so it is
also the fastest way to write a new test.

Headed runs insert a 400ms pause between actions so they are followable at
human speed. Override per-run:

```bash
SLOWMO=0 npm run test:e2e      # full speed
SLOWMO=1200 npm run test:e2e   # slow enough to demo
```

On Windows PowerShell, set it as `$env:SLOWMO=1200` on its own line first.

### Not every test opens a browser

API tests use Playwright's `request` fixture and never launch one — they are
much faster that way, and there is nothing to look at. Browser-visible specs
live in `tests/e2e/shell.spec.ts` and the feature specs that follow; pure API
assertions belong in `smoke.spec.ts` and its successors. If a headed run looks
like it skipped something, that is why.

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

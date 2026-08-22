# Project state

_Update this file at the end of every working session._

## Current phase

**Phases 0–6 complete**, and verified against a real Gmail account rather than
only against mocks.

Next: Phase 8 (design pass), then Phase 9 (deploy). Phase 7 — Google
verification — is deliberately deferred; see the cost note in ADR 0002.

## What works

- **Auth** — passwordless login by emailed code, sessions in an HttpOnly
  cookie, deny-by-default on every account-scoped route.
- **Gmail connection** — full OAuth round trip with CSRF state, tokens
  encrypted at rest, `reauth_required` handling, disconnect.
- **Mailbox** — unified search across accounts using Gmail's own syntax,
  multi-select, bulk move to Trash.
- **Trash bin** — browse, restore, and permanently delete behind a
  type-to-confirm dialog.
- **Cleanup rules** — saved searches that trash on a manual/daily/weekly
  schedule, run by an hourly cron pass.
- **Compose** — send from any connected identity.
- **Legal** — `/privacy` and `/terms`, written to match what the code does.
- **Hardening** — API rate limiting; bodies never persisted; audit trail for
  every connect, disconnect, trash, restore, permanent delete, send and rule
  run.
- **UI** — landing page, left-sidebar app shell, three-way theme switching,
  skeleton loading, custom 404/offline/500/403 screens, installable PWA.

53 Playwright tests, green headed and headless. CI green.

## Local setup notes

- **Dev runs over HTTPS.** Google refuses restricted scopes to any OAuth client
  with an `http://` redirect URI, localhost included. Run
  `sh scripts/make-cert.sh` once and trust the CA — see
  `docs/07-external-accounts-setup.md` §1g.
- **Dev database is a local SQLite file** (`local.db`, gitignored), not Turso,
  so the project boots with no external accounts.
- `start.bat` / `stop.bat` / `restart.bat` / `status.bat` run the servers in
  the background; logs land in `.logs/`.

## Deferred, deliberately

- **Resend** — `RESEND_API_KEY` unset, so login codes print to the server log
  instead of being emailed. Sending from `Bee <no-reply@bee.harshitsaini.in>`
  also needs that subdomain verified in Resend.
- **Turso** — not needed until deploy.
- **Google verification** — the app stays in Testing mode (free, 100 users).
  Publishing with `https://mail.google.com/` triggers a CASA assessment that
  may cost real money. Confirm the tier and price before starting; dropping
  the scope is the expected answer if it is not free.

## Known gaps

- Bulk trash has no live progress bar. The WebSocket server is mounted but no
  job reports through it yet, so a large batch just takes a while.
- Search pagination is per-account and the UI only shows the first page.
- The message index table exists but nothing writes to it — search currently
  goes straight to Gmail every time. Fine at this scale; the sync engine that
  fills it is what makes it fast later.

## Next up

1. **Phase 8 — design pass.** Claymorphism tokens carried over from Orbit.
2. **Phase 9 — deploy.** Vercel + Render + Turso + Resend, real domain, then
   restore the repo's homepage link.

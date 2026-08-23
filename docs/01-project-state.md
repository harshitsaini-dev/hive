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

## Google verification: not happening

The app is **published without verification** (23 August 2026). No CASA, no
cost, and refresh tokens no longer expire weekly the way they did in Testing
mode. The trade is a 100-user cap and an unverified-app warning on the consent
screen that every new user has to click past. See ADR 0002.

## Known gaps

- **Nothing writes to `message_index`.** Every search goes to Gmail. With the
  batch endpoint that is roughly 1.5s per hundred messages, so the index is
  not yet worth the sync machinery — a `history.list` cursor, a 30-day horizon
  and a full re-index path — that filling it would require.
- **Bulk progress is polled, not pushed.** A WebSocket server is mounted but
  unreachable from the browser: Vercel does not proxy WebSocket upgrades, so a
  socket would be cross-origin and the session cookie would not go with it.
  Polling a job id through the existing proxy works and is what ships.
- **Jobs live in memory.** Fine on one Render instance; if the API is ever
  scaled out, a poll could reach a process that never heard of the job.

## Live

- **App:** https://hive.harshitsaini.in (Vercel)
- **API:** https://hive-api-s1u3.onrender.com (Render), proxied at `/api`
- **Database:** Turso, ap-south-1
- **Login email:** Resend, from `Bee <no-reply@bee.harshitsaini.in>`

Verified end to end on 2026-08-23: landing, privacy, terms, API proxy,
database readiness, security headers, and a real login code delivered.

`npm run test:live` runs browser smoke tests against the deployed site.
Two pingers keep the Render instance awake so scheduled cleanup rules actually
fire — see `docs/04-deployment.md`.

## Next up

Nothing outstanding from the roadmap. Possible future work, in rough order of
value:

1. **The sync engine** that fills `message_index`, if search to Gmail ever
   starts to feel slow. It needs a history cursor, a 30-day horizon and a full
   re-index fallback, so it is real work for a benefit that is not felt yet.
2. **Moving jobs to the database**, only if the API is ever scaled past one
   instance.
3. **Verification**, only if the 100-user cap ever binds — and only after
   confirming what CASA costs. See ADR 0002.

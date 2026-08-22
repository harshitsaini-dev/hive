# Project state

_Update this file at the end of every working session._

## Current phase
**Phase 0 — Foundation.** Essentially complete; `npm run dev` boots and the
smoke suite is green. Phase 1 starts once the Google Cloud OAuth client is in
`.env`.

## Done
- Master plan written (`hive-master-plan.md`).
- Git repo initialised locally (`main` branch), **not yet pushed** — no GitHub
  remote exists.
- Project-local git identity configured: `harshitsaini-dev /
  harshitsaini.dev@gmail.com`. Global git identity deliberately left unset.
- `GH_CONFIG_DIR` convention adopted (`.gh-config/`, gitignored) so GitHub CLI
  auth is scoped to this folder. See `docs/05-local-git-github.md`.
- `CLAUDE.md` and `.claude/settings.json` in place; commit attribution
  trailers disabled.
- Docs skeleton and testing conventions written.
- `gh` authenticated as `harshitsaini-dev` with config in `.gh-config/`
  (token itself in the Windows keyring — see `docs/05-local-git-github.md`).
- Public repo live at https://github.com/harshitsaini-dev/hive, `main` pushed
  and tracking `origin/main`.
- Open-source files in place: MIT `LICENSE`, `README.md`, `CONTRIBUTING.md`,
  `docs/SELF-HOSTING.md`, `.env.example`, issue templates, ADR 0001.
- **Monorepo scaffolded and booting.** npm workspaces across `apps/web`,
  `apps/server`, `packages/{db,gmail-client,shared-types}`.
  - Server: Express + ws + config validation that fails at boot, AES-256-GCM
    token encryption, one error envelope, health/readiness endpoints.
  - DB: full initial migration (all six tables plus `login_otps`), forward-only
    migration runner.
  - Web: Vite + React shell that proves the dev proxy reaches the API.
  - Playwright smoke suite — 3 tests, green headed *and* headless.
  - CI workflow: typecheck, build, and the e2e suite.
- Google OAuth client created; `GOOGLE_CLIENT_ID`/`SECRET` and both crypto
  keys are in `.env`.

### Dev database
Development uses a local SQLite file at the repo root (`local.db`, gitignored)
rather than Turso, so the project boots with no accounts and no network. Set
`TURSO_DATABASE_URL` to switch; the same libsql client handles both.

## Blocked / waiting on you
- **Resend** — deliberately deferred to deploy time. `RESEND_API_KEY` is unset,
  so login codes cannot be delivered yet; the server warns about this at boot.
  Sending from `Bee <no-reply@bee.harshitsaini.in>` will also need the
  subdomain verified in Resend (DNS records) before it works at all.
- **Turso** — not needed until deploy, per the note above.

## Next up
Phase 1 — auth and the Gmail connect flow:
1. OTP login (routes exist but cannot deliver mail until Resend is configured
   — develop against the code logged to the console).
2. Session cookies, `requireAuth` middleware.
3. `GET /accounts/oauth/start` and the callback: token exchange, encryption,
   `connected_accounts` row, `connect` audit entry.
4. **Prove one real Gmail account connects end-to-end** before building
   anything on top of it.

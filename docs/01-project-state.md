# Project state

_Update this file at the end of every working session._

## Current phase
**Phase 0 — Foundation.** Repo scaffolding and local tooling setup.

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

## Blocked / waiting on you
- **Google Cloud project** — create it, enable the Gmail API, configure the
  OAuth consent screen (External / Testing, add yourself as a test user).
  Per the master plan, one real account must connect end-to-end before any
  further Gmail-facing code is written.
- **Turso and Resend accounts** — needed before the server can boot with real
  config. Both have free tiers; no card required.

## Next up
1. Scaffold the npm workspaces (`apps/web`, `apps/server`, `packages/*`).
2. `LICENSE` (MIT), `README.md`, `.env.example`, CI workflows.
3. Phase 1 — OTP login + single Gmail OAuth connect flow.

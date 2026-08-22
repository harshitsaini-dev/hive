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

## Blocked / waiting on you
- **`gh auth login`** — interactive, must be run by a human in a terminal.
  Commands in `docs/05-local-git-github.md` §3.
- **`gh repo create hive --public`** — after login.
- **Google Cloud project** — create it, enable the Gmail API, configure the
  OAuth consent screen (External / Testing, add yourself as a test user).
  Per the master plan, one real account must connect end-to-end before any
  further Gmail-facing code is written.

## Next up
1. Finish local GitHub CLI login, create the public repo, first push.
2. Scaffold the npm workspaces (`apps/web`, `apps/server`, `packages/*`).
3. Phase 1 — OTP login + single Gmail OAuth connect flow.

# CLAUDE.md — Hive

## What this project is
Hive is an open-source, hosted multi-account Gmail manager: connect any number
of Gmail accounts via OAuth, search and bulk-clean across all of them, and
compose/send from any connected identity. MIT licensed, public repo, hosted at
hive.harshitsaini.in. Full design in docs/02-architecture.md. Read
docs/01-project-state.md first, every session.

## Non-negotiable rules

### Git & attribution
- NEVER add a Co-Authored-By trailer or "Generated with Claude Code" text to
  commits or PRs. .claude/settings.json already sets attribution.commit/pr to
  empty strings — do not remove that.
- Commit messages: imperative, human voice, conventional commits. No
  AI/Claude/Anthropic mentions anywhere in code, comments, README, or docs.
- Use `gh` for repo/PR/issue operations.
- Git identity and gh auth are **project-local only**. Never set or rely on
  global `user.name`/`user.email`, and never run `gh auth login` without
  `GH_CONFIG_DIR` pointed at `.gh-config/`. See docs/05-local-git-github.md.

### Destructive-action discipline (load-bearing for this project)
The app holds the restricted https://mail.google.com/ scope, so it CAN destroy
mail irrecoverably. See docs/decisions/0002-permanent-delete.md.

- batchDelete is reachable from exactly ONE place: an explicit, type-to-confirm
  user action in the Trash view. Never widen that surface.
- Bulk cleanup and cleanup rules ALWAYS trash (batchModify), never delete. A
  scheduled irreversible action against a query written weeks ago is the most
  dangerous thing this codebase could do — do not add one, whatever the ask.
- Every delete_forever writes its audit_log row BEFORE the Gmail call, so a
  partial failure still leaves a record of what was attempted.
- Permanent-delete controls check the granted scope at runtime. If the scope is
  ever dropped, the Trash view degrades to view-and-restore rather than
  throwing.
- The app stays in Google Testing mode (free, 100 users). Going public with
  this scope triggers a CASA assessment that may cost real money — flag it
  before any verification work, never assume it is free.

### Documentation discipline
- Update docs/01-project-state.md every session; append a dated entry to
  docs/daily-log/YYYY-MM-DD.md.
- Any scope, licensing, or verification-related decision gets an ADR in
  docs/decisions/.
- docs/SELF-HOSTING.md and .env.example must stay accurate as the project
  evolves.

### Testing
- Playwright, **headed mode locally** (`headless: false`), headless in CI.
- Any route touching trash or send needs a test asserting the audit_log row
  was written.

### Privacy & legitimacy
- /privacy and /terms pages must stay accurate to what the code actually does.
- Never persist full email body/attachment content to Turso — message_index
  is metadata only.
- Encrypt all tokens at rest; never log them.

### Cost discipline
- No new paid tier or card-requiring service without flagging it first and
  proposing a free alternative.

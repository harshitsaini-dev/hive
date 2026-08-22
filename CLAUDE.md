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

### Scope discipline (this is the load-bearing rule for this project)
- The hosted product requests ONLY gmail.readonly, gmail.modify, gmail.send.
  NEVER add https://mail.google.com/ (full mailbox scope) to the hosted app's
  OAuth request without an explicit ADR explaining why and confirming CASA
  implications — this scope change affects Google verification status.
- "Delete" in the hosted product means trash (batchModify), never
  batchDelete. If a self-hosting user wants true permanent delete on their
  own instance, that's documented in docs/SELF-HOSTING.md as something they
  opt into themselves, not a hosted-product default.

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

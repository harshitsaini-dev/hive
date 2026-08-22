# Contributing to Hive

Thanks for taking a look. Issues and pull requests are both welcome.

## Getting it running

```bash
git clone https://github.com/harshitsaini-dev/hive.git
cd hive
npm install
cp .env.example .env
npm run dev
```

Every variable in `.env.example` is commented with where to get it.
[docs/07-external-accounts-setup.md](docs/07-external-accounts-setup.md) is the
long-form walkthrough — you will need your own Google Cloud project with the
Gmail API enabled before anything Gmail-facing will work.

**Use a throwaway Gmail account for development.** Hive trashes mail in bulk.
Do not point it at an inbox you care about.

## Layout

```
apps/web         React SPA
apps/server      REST API, WebSocket, cron jobs
packages/gmail-client   Gmail API wrapper
packages/db             Turso schema, migrations, queries
packages/shared-types   Types shared across the boundary
docs/            Architecture, decisions, setup guides
```

## Conventions

- **Commits** — [Conventional Commits](https://www.conventionalcommits.org/):
  `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`. Imperative mood.
- **TypeScript everywhere.** No `any` without a comment explaining why.
- **Tests** — Playwright for end-to-end, run headed locally and headless in
  CI. See [docs/06-testing.md](docs/06-testing.md).

## Two rules that are not negotiable

These protect the project's Google verification status and its privacy
claims. A PR that breaks either will be asked to change regardless of how good
the rest of it is.

**1. Scopes stay at `gmail.readonly`, `gmail.modify`, `gmail.send`.**
Adding the restricted `https://mail.google.com/` scope triggers a CASA
security assessment for the hosted app. "Delete" means trash
(`batchModify`), never `batchDelete`. If you want to change this, open an
issue proposing an ADR first rather than a PR.

**2. Email bodies are never persisted.** `message_index` holds metadata only —
subject, sender, date, labels, snippet, message ID. Bodies come from the Gmail
API on demand. The privacy policy depends on this being literally true.

Also: OAuth tokens are encrypted at rest and must never be logged, and
`/privacy` and `/terms` have to stay accurate to what the code actually does.

## Decisions

Anything affecting scopes, licensing, or Google verification gets an ADR in
[docs/decisions/](docs/decisions/). If you find yourself wondering "why is it
done this way" and the answer is not written down, that is a good issue to
open.

## Pull requests

1. Branch from `main`.
2. Keep the diff focused — one concern per PR.
3. Make sure `npm run build`, `npm run lint`, and the test suite pass.
4. Describe what changed and why. Screenshots for UI changes.

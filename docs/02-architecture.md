# Architecture

The authoritative design lives in [`../hive-master-plan.md`](../hive-master-plan.md).
This file summarises it and is where architectural detail should grow as the
code lands. Where the two disagree, the master plan wins until this file is
explicitly updated to supersede it.

## Shape

- **Frontend** — React SPA on Vercel.
- **Backend** — Render: REST API, a WebSocket channel for bulk-action progress,
  and `node-cron` for sync plus scheduled cleanup rules.
- **Database** — Turso (`hive.db`): `users`, `connected_accounts`,
  `cleanup_rules`, `audit_log`, `message_index`, `sessions`.
- **Email delivery** — Resend, for login OTPs only.
- **Google** — standard OAuth 2.0; every account connects through one code
  path, personal or Workspace alike.

## Load-bearing constraints

These are not implementation details — changing any of them changes the
project's Google verification posture or its privacy claims.

1. **Scopes are exactly `gmail.readonly`, `gmail.modify`, `gmail.send`.**
   Adding `https://mail.google.com/` pulls the hosted app into a CASA security
   assessment. Requires an ADR first.
2. **Delete means trash.** `batchModify`, never `batchDelete`. Gmail empties
   its own Trash after 30 days, so the user-visible outcome is the same
   without the restricted scope.
3. **No email bodies at rest.** `message_index` holds
   subject/sender/date/labels/snippet/message-ID only; bodies are fetched from
   the Gmail API on demand. This is what makes the privacy policy short and
   true.
4. **Tokens encrypted at rest, never logged.**

## Sync engine

Incremental via `users.history.list` against a stored per-account `historyId`.
Gmail's history only reaches back ~30 days — if an account has been out of
sync longer than that (typically after sitting in `reauth_required`), a stale
`historyId` is untrustworthy and the account must fall back to a **full
re-index**. Build that fallback from day one; it is not an edge case, it is
the normal consequence of any lapsed reauth.

## Quotas worth surfacing in the UI

Consumer Gmail allows roughly 500 sends/day, Workspace roughly 2,000. Show a
quota indicator rather than letting a bulk send fail silently against
Google's limit.

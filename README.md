# Hive

Manage several Gmail accounts from one place. Search across all of them at
once, bulk-clean the clutter, and send from whichever identity you need —
without juggling browser tabs and profile switchers.

Open source under MIT. Hosted at [hive.harshitsaini.in](https://hive.harshitsaini.in),
and self-hostable if you would rather run your own.

> **Status: early development.** Phase 0 of the roadmap. Not usable yet.

## What it does

- **Unified inbox and search** across every connected account, using Gmail's
  own search syntax (`from:`, `has:attachment`, `older_than:`, `label:`).
- **Bulk trash** with live progress — select a few thousand messages and watch
  them go. Reversible: everything lands in Gmail's Trash, which Google empties
  after 30 days.
- **Cleanup rules** — saved queries that run on a schedule. "Promotions older
  than 30 days, weekly" and you stop thinking about it.
- **Compose and send** from any connected account, with a daily-quota
  indicator so a bulk send does not fail silently against Google's limits.

## What it deliberately does not do

**Permanent delete.** Doing that requires Gmail's restricted full-mailbox
scope, which would mean a heavier security review and asking every user for
far broader access than the product needs. Trash reaches the same end state
via a much smaller permission. If you self-host and genuinely want instant
permanent delete, you can add that scope to your own instance — see
[docs/SELF-HOSTING.md](docs/SELF-HOSTING.md).

**Store your email.** Hive keeps an index — subject, sender, date, labels,
snippet, message ID — so search is fast. Message bodies and attachments are
fetched from Gmail on demand and never persisted. OAuth tokens are encrypted
at rest.

## Stack

React on Vercel, Node on Render (REST + WebSocket + cron), Turso for metadata,
Resend for login OTPs. Design and rationale in
[docs/02-architecture.md](docs/02-architecture.md).

## Running it locally

```bash
git clone https://github.com/harshitsaini-dev/hive.git
cd hive
npm install
cp .env.example .env     # then fill it in
npm run dev
```

You will need your own Google Cloud project with the Gmail API enabled.
[docs/07-external-accounts-setup.md](docs/07-external-accounts-setup.md) walks
through it, and [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md) covers deploying
your own instance.

## Contributing

Issues and pull requests welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)

# Hive

Manage several Gmail accounts from one place. Search across all of them at
once, bulk-clean the clutter, and send from whichever identity you need —
without juggling browser tabs and profile switchers.

Open source under MIT, and self-hostable if you would rather run your own.

> **Status: early development.** Not usable yet — there is no login, no Gmail
> connection, and nothing to try. A hosted instance will go up at
> `hive.harshitsaini.in` once it is worth using; until then the only way to
> run it is locally.

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

## About deleting

**Bulk cleanup always trashes.** Anything Hive clears in bulk goes to Gmail’s
Trash, recoverable for thirty days. That is the only thing a search, a
multi-select or a scheduled rule can ever do.

**Permanent deletion exists, but is deliberately awkward.** It lives only in
the Trash view, needs a typed confirmation showing the exact count, and can
never run on a schedule. There is no undo, so the product treats it that way.

## What it does not store

Hive keeps an index — subject, sender, date, labels, snippet, message ID — so
search is fast. Message bodies and attachments are fetched from Gmail on demand
and **never persisted**. OAuth tokens are encrypted at rest and never logged.

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

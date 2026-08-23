# Hive

**Manage several Gmail accounts from one place.** Search across all of them at
once, work out what is actually filling them up, bulk-clean the clutter, and
send from whichever identity you need — without juggling browser tabs and
profile switchers.

Open source under MIT, and self-hostable if you would rather run your own.

**Live at [hive.harshitsaini.in](https://hive.harshitsaini.in).** It is
published but not Google-verified, so the consent screen shows an
unverified-app warning and there is a 100-user cap. If that bothers you,
[run your own](docs/SELF-HOSTING.md) — that is what the licence is for.

---

## What it does

### Search everything at once

- **Unified search across every connected mailbox.** Results merge by date, so
  you get one list rather than one list per account.
- **Searching means searching**, not searching the folder you happen to be
  standing in. Apply any filter and Hive covers inbox, sent, archive and trash
  — the way Gmail's own search does. It says which reach it used, and one
  click narrows it back to the current folder.
- **Filters, not syntax.** Sender, age, category, attachments, unread, and a
  custom date range, all as controls. The raw Gmail-syntax box is still there
  if you want it, and it shows you what your filters compile to.
- **Ctrl+K** for a quick search across every account from anywhere.

### Know what is in there

The **mailbox analysis** answers the question a full mailbox actually raises:
*what is all this, and who keeps sending it?*

- How many messages match, how many carry an attachment, how many do not.
- A ranked list of senders, with per-mailbox and attachment breakdowns.
- The three totals and the per-mailbox chips are **filters** — press one and
  everything below narrows to it.
- Select senders and **view** their mail before deciding, or **clear** them
  out in one go.

### Clean up, carefully

- **Bulk trash** with live progress. Select a page, or select everything a
  search matches — the count is resolved server-side, so it is a real number
  rather than "however many happen to be loaded".
- **Cleanup rules** — saved queries that run daily or weekly. *"Promotions
  older than 30 days, weekly"* and you stop thinking about it.
- **A Trash view** — browse the bin, restore from it, or permanently delete.

### Everything else

- **Read mail in place**, with embedded images resolved and attachments shown
  as pictures rather than filenames. Remote images stay blocked.
- **Compose and send** from any connected identity, with attachments.
- **Installable PWA**, works on a phone, three-way light/dark/system theming.
- **Passwordless login** by emailed code. No password to leak.

---

## About deleting

This is the part of the project that gets the most care, so it is worth being
explicit about.

**Bulk cleanup always trashes.** Anything Hive clears in bulk — a search, a
multi-select, a cleanup rule, a sender cleared from the analysis — goes to
Gmail's Trash and is recoverable for thirty days.

**Permanent deletion exists, and is deliberately awkward.** It lives in
exactly one place: the Trash view. It needs a typed confirmation showing the
exact count. It can never run on a schedule, and no automated path reaches it.
There is no undo, so the product treats it that way. Every permanent delete
writes its audit row *before* the call, so a partial failure still leaves a
record of what was attempted.

See [ADR 0002](docs/decisions/0002-permanent-delete.md) for the full
reasoning, including what the restricted scope costs.

---

## What Hive stores, and what it does not

Hive keeps a **local index** of message metadata — sender, subject, date,
labels, Gmail's own short snippet, and whether a message carries an
attachment. That is what makes searching and analysing fast.

**Message bodies and attachments are never persisted.** When you open a
message, Hive fetches it from Gmail at that moment and discards it. OAuth
tokens are encrypted with AES-256-GCM at rest and never logged. Sessions and
login codes are stored hashed.

Disconnecting a mailbox deletes its credentials and its index.

### Why there is an index at all

One asymmetry in the Gmail API shapes most of this project: **counting is
cheap and reading is not.** Message ids come back 500 to an API call, so
counting even a hundred thousand matches is a couple of hundred requests. But
learning *anything about* a message — who sent it — costs one request each,
against a quota of roughly 3,000 a minute.

So "who sends me the most" takes about half an hour on a large mailbox if you
ask Gmail every time. Asked once and stored, it is a `GROUP BY`. The index
backfills in the background across hourly passes, resumes where it stopped if
interrupted, and then keeps itself current from Gmail's history feed.

---

## Stack

React + Vite on Vercel. Node (Express 5, `ws`, `node-cron`) on Render. Turso
(libSQL) for metadata. Resend for login codes. TypeScript end to end, npm
workspaces, Playwright for tests.

Design and rationale in [docs/02-architecture.md](docs/02-architecture.md);
the decisions that were genuinely arguable are written up as ADRs in
[docs/decisions/](docs/decisions/).

---

## Running it locally

```bash
git clone https://github.com/harshitsaini-dev/hive.git
cd hive
npm install
cp .env.example .env     # every variable is commented
npm run db:migrate
npm run dev
```

You need your own Google Cloud project with the Gmail API enabled.
[docs/07-external-accounts-setup.md](docs/07-external-accounts-setup.md) walks
through it step by step.

**Dev runs over HTTPS.** Google refuses restricted scopes to any OAuth client
with an `http://` redirect URI, localhost included — so run
`sh scripts/make-cert.sh` once and trust the generated CA. On Windows,
`start.bat` / `stop.bat` / `restart.bat` run both servers in the background.

### Tests

```bash
npm run test:e2e            # headed, so you can watch it
npm run test:e2e:headless   # what CI runs
```

---

## Self-hosting

[docs/SELF-HOSTING.md](docs/SELF-HOSTING.md) covers the whole thing: the
Google Cloud project and consent screen, whether to request the restricted
scope at all, Turso, Resend, the environment variables, and deploying to
Vercel and Render (both free tiers).

Two things worth knowing before you start:

- **`TOKEN_ENCRYPTION_KEY` must be backed up.** It encrypts every stored Gmail
  token. Lose it and every connected account needs reconnecting.
- **The restricted `https://mail.google.com/` scope is optional.** It is only
  needed for permanent deletion. Leave it out and Hive degrades to
  view-and-restore in the Trash view — checked at runtime, no code change.
  Requesting it and then seeking verification is what triggers a CASA
  assessment, which may cost real money.

---

## Contributing

Issues and pull requests welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)

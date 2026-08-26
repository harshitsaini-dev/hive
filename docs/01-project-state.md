# Project state

_Update this file at the end of every working session._

## Current phase

**Phases 0–6 complete**, and verified against a real Gmail account rather than
only against mocks.

Next: Phase 8 (design pass), then Phase 9 (deploy). Phase 7 — Google
verification — is deliberately deferred; see the cost note in ADR 0002.

## What works

- **Auth** — passwordless login by emailed code, sessions in an HttpOnly
  cookie, deny-by-default on every account-scoped route.
- **Gmail connection** — full OAuth round trip with CSRF state, tokens
  encrypted at rest, `reauth_required` handling, disconnect.
- **Mailbox** — unified search across accounts using Gmail's own syntax,
  multi-select, bulk move to Trash. Which mailboxes a search covers is chosen
  from a searchable multi-select; choosing none means all of them.
- **Trash bin** — browse, restore, and permanently delete behind a
  type-to-confirm dialog.
- **Cleanup rules** — saved searches that trash on a manual/daily/weekly
  schedule, run by an hourly cron pass. A rule can be built for several
  mailboxes at once (saved as one rule apiece) and for several senders picked
  from the index rather than typed.
- **Compose** — send from any connected identity.
- **Legal** — `/privacy` and `/terms`, written to match what the code does.
- **Hardening** — API rate limiting; bodies never persisted; audit trail for
  every connect, disconnect, trash, restore, permanent delete, send and rule
  run.
- **A local message index** — metadata for every message, backfilled in the
  background and kept current from Gmail's history feed. Structural searches
  are answered from it outright; text searches still go to Gmail for the
  matching and come back hydrated from the index.
- **Mailbox analysis** — how much mail matches, how much of it carries a
  file, and who sent it. The three totals and the per-mailbox chips are
  filters that narrow everything below them; senders can be selected in bulk
  and viewed or cleared. Runs survive closing the tab, are stored per user so
  they appear on any device, and can be put on a daily or weekly schedule.
- **UI** — landing page, left-sidebar app shell, three-way theme switching,
  skeleton loading, custom 404/offline/500/403 screens, installable PWA,
  custom date picker, themed scrollbars, in-app confirmation dialogs.

192 Playwright tests, green headed and headless — including a mobile suite
that emulates a phone properly, after the discovery that the previous one
emulated touch without a touch pointer and so tested none of the rules it was
written for. CI green.

## Local setup notes

- **Dev runs over HTTPS.** Google refuses restricted scopes to any OAuth client
  with an `http://` redirect URI, localhost included. Run
  `sh scripts/make-cert.sh` once and trust the CA — see
  `docs/07-external-accounts-setup.md` §1g.
- **Dev database is a local SQLite file** (`local.db`, gitignored), not Turso,
  so the project boots with no external accounts.
- `start.bat` / `stop.bat` / `restart.bat` / `status.bat` run the servers in
  the background; logs land in `.logs/`.

## Google verification: not happening

The app is **published without verification** (23 August 2026). No CASA, no
cost, and refresh tokens no longer expire weekly the way they did in Testing
mode. The trade is a 100-user cap and an unverified-app warning on the consent
screen that every new user has to click past. See ADR 0002.

## The economics that shape the mailbox features

Worth stating once, because nearly every design decision in search and
analysis follows from it:

- **Counting is nearly free.** Message ids come back 500 to an API call, so
  even a hundred-thousand-message query is a couple of hundred cheap calls and
  the count is exact.
- **Reading anything about a message is not.** Sender, subject and date each
  need a metadata fetch — one request per message, against a quota of roughly
  3,000 a minute. A page of 500 messages across three mailboxes is already
  about half a minute's allowance.

That is why the mail list paginates rather than loading everything (an
auto-loading version was built and reverted the same day — it exhausted the
quota within seconds), and why a finished analysis is persisted rather than
recomputed.

**The index is the answer to that asymmetry**, and it changes the arithmetic
rather than working around it:

- A **structural** search — folder, sender, dates, attachments, unread — is a
  SQL query, and comes back with an exact total instead of a page count.
- A **text** search still goes to Gmail, because Gmail searches message bodies
  and the index holds none: storing them is what the privacy policy forbids.
  But Gmail answers with *ids*, which is the cheap half; the rows behind those
  ids come from the index. So a text search of an indexed mailbox costs one
  Gmail call however many messages it matches.
- The **sender rollup** stops being sampled at all, so its "newest N of M"
  caveat disappears once a mailbox finishes backfilling.

## Known gaps

- **Nothing writes to `message_index`.** Every search goes to Gmail. With the
  batch endpoint that is roughly 1.5s per hundred messages, so the index is
  not yet worth the sync machinery — a `history.list` cursor, a 30-day horizon
  and a full re-index path — that filling it would require.
- **Bulk progress is polled, not pushed.** A WebSocket server is mounted but
  unreachable from the browser: Vercel does not proxy WebSocket upgrades, so a
  socket would be cross-origin and the session cookie would not go with it.
  Polling a job id through the existing proxy works and is what ships.
- **Jobs live in memory.** Fine on one Render instance; if the API is ever
  scaled out, a poll could reach a process that never heard of the job. The
  same applies to the in-flight analysis registry that lets a reopened tab
  reattach to a running scan.
- **The sender name has three sources and no guarantee.** Google's profile
  (needs the mailbox reconnected since the scope was added), Gmail's `sendAs`
  alias, and the `From` header of the mailbox's own sent mail. A brand-new
  account connected without the profile scope and with an empty Sent folder
  still sends under a bare address.
- **A cleared sender lingers in the stored analysis** until the next run. The
  row disappears from the screen immediately; correcting the saved copy would
  mean a write per cleared sender, and the figures are already a snapshot of a
  mailbox that keeps moving.
- **Scheduled analysis is capped by the same scan depth as a manual run.**
  "Everything" on a very large mailbox can take hours of a per-minute quota,
  which is exactly why the schedule exists — but it is unattended, so a
  failure is only visible in the logs and as a stale timestamp.

## Live

- **App:** https://hive.harshitsaini.in (Vercel)
- **API:** https://hive-api-s1u3.onrender.com (Render), proxied at `/api`
- **Database:** Turso, ap-south-1
- **Login email:** Resend, from `Bee <no-reply@bee.harshitsaini.in>`

Verified end to end on 2026-08-23: landing, privacy, terms, API proxy,
database readiness, security headers, and a real login code delivered. The
server applies outstanding migrations at boot, so a deploy no longer needs
`npm run db:migrate` run by hand.

`npm run test:live` runs browser smoke tests against the deployed site.
Two pingers keep the Render instance awake so scheduled cleanup rules actually
fire — see `docs/04-deployment.md`.

## Next up

Nothing outstanding from the roadmap. Possible future work, in rough order of
value:

1. **Simplifying the analysis panel.** Its scan-depth selector is close to
   meaningless now: on an indexed mailbox the depth changes nothing, because
   nothing is being sampled. Leaving a control that only matters mid-backfill
   is a small lie about how the feature works.
2. **An accessibility pass.** Never done systematically — keyboard reach,
   focus order, contrast, live regions. Cheap now, expensive later.
3. **Moving jobs to the database**, only if the API is ever scaled past one
   instance.
4. **Verification**, only if the 100-user cap ever binds — and only after
   confirming what CASA costs. See ADR 0002.

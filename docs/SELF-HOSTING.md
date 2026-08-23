# Self-hosting Hive

Running your own instance means you are your own Google Cloud project's owner.
The practical upshot: you never hit the hosted app's 100-user Testing cap for
your own accounts, you never wait on Google's verification queue, and you can
choose your own OAuth scopes.

Everything below is free-tier. No card required at any step.

## 1. Google Cloud

Follow [07-external-accounts-setup.md](07-external-accounts-setup.md) §1 — it
covers creating the project, enabling the Gmail API, configuring the consent
screen, and creating an OAuth client.

Two differences for a self-hosted instance:

- **Redirect URI** — register your real deployed callback
  (`https://your-domain/auth/google/callback`) in addition to, or instead of,
  the localhost one.
- **Test users** — add every Gmail address you intend to connect. In Testing
  mode you can add up to 100 and never need verification at all.

### About Testing mode and the 7-day token expiry

An unverified app in Testing mode gets refresh tokens that expire after seven
days. For a personal instance this means reconnecting your accounts weekly,
which is annoying but not broken — Hive surfaces it as `reauth_required`.

Three ways out, in rough order of how much trouble they are:

1. **Publish without verifying.** Setting the app to "In production" removes
   the weekly expiry immediately. The trade is a 100-user cap and an
   unverified-app warning every new user has to click past. This is what the
   hosted instance does, and for a personal instance it is almost always the
   right answer.
2. **Publish Internal**, if every account belongs to a Google Workspace you
   administer. No warning, no cap, no verification.
3. **Verify.** Only worth it if the user cap actually binds — and confirm what
   CASA costs first if you kept the restricted scope. See
   [ADR 0002](decisions/0002-permanent-delete.md).

## 2. Permanent delete, if you actually want it

The hosted product deliberately only trashes mail. Trash auto-empties after 30
days, so the end state is the same; the reason for the restriction is that
true permanent delete needs `https://mail.google.com/`, a restricted scope
that would subject the hosted app to a CASA security assessment.

On your own instance that calculus is different — with your own project and a
handful of test users, there is no verification to fail. If you want it:

1. Add `https://mail.google.com/` to your consent screen's scopes.
2. Add it to the scope list your instance requests.
3. Switch the relevant calls from `batchModify` to `batchDelete`.

**This is irreversible.** `batchDelete` does not put messages in Trash — they
are gone, with no undo and no recovery. Do not enable it without being certain,
and never point such an instance at an inbox you have not backed up.

Do not send this change upstream as a PR — it is intentionally not the hosted
default, and `CONTRIBUTING.md` treats it as an ADR-level decision.

## 3. Database and email

- **Turso** — create a database, copy the URL and auth token. Any libSQL or
  SQLite-compatible host works if you would rather not use Turso.
- **Resend** — an API key for login OTP delivery. To send from your own domain
  rather than `onboarding@resend.dev`, verify the domain in Resend and add the
  DNS records it gives you.

## 4. Configure and run

```bash
git clone https://github.com/harshitsaini-dev/hive.git
cd hive
npm install
cp .env.example .env
```

Fill in `.env` — every variable is commented. Generate the two secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

`TOKEN_ENCRYPTION_KEY` encrypts Gmail OAuth tokens at rest. **Back it up.**
Rotating or losing it invalidates every stored token and every connected
account will need reconnecting.

```bash
npm run db:migrate
npm run dev
```

The server also applies outstanding migrations at boot, so the explicit step
above is a convenience rather than a requirement — but running it once first
tells you immediately whether your database credentials are right.

### The message index

Once a mailbox is connected, Hive backfills a local index of message metadata
in the background: sender, subject, date, labels, snippet, and whether the
message carries an attachment. **Never message content.**

It matters for self-hosting because of the shape of the work. The first pass
over a large mailbox reads every message — one Gmail request each, against a
quota of about 3,000 a minute — so it takes hours, spread across hourly runs
so it never monopolises the connection. Everything after that is only what
changed, via Gmail's history feed.

Progress is visible in the Rules view, where it can also be paused per
mailbox. Pause it if you connected an account only to send from it: searching
and analysing still work, they just ask Gmail directly and are slower.

## 5. Deploying

The hosted instance runs the frontend on Vercel and the backend on Render, but
nothing depends on those specifically — the server is a plain Node process and
the web app is a static build.

Whatever you choose:

- Set every `.env` variable as a secret in the platform's dashboard. Never
  commit `.env`.
- Point `GOOGLE_REDIRECT_URI` at your deployed callback and register that
  exact URL in the Google Cloud console.
- Set `WEB_ORIGIN` to your frontend's origin so CORS allows it.
- Set `NODE_ENV=production`.
- The backend needs to stay running for cron-based sync and cleanup rules —
  a platform that sleeps idle instances will delay scheduled runs.

## 6. Publishing your instance publicly

If you intend to let strangers connect their accounts, you need what the
hosted instance needs: OAuth verification, a real privacy policy and terms of
service at reachable URLs, your domain verified in Google Search Console, and
a demo video showing how each requested scope is used.

Both `/privacy` and `/terms` must accurately describe **your** deployment. If
you changed the scopes — particularly if you added permanent delete — the
shipped copy is no longer true for your instance, and Google's reviewers read
these pages. Update them.

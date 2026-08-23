# Deploying Hive

Everything here is free tier. No card required at any step.

The shape: **Vercel** serves the web app and proxies `/api` through to
**Render**, which runs the API. **Turso** holds the database, **Resend** sends
login codes, **Cloudflare** points the domain at Vercel.

## Why the API is proxied rather than called directly

Sessions are HttpOnly, `SameSite=Lax` cookies. A browser will not attach those
to a cross-origin `fetch`, so calling `hive-api.onrender.com` straight from
`hive.harshitsaini.in` would leave every request unauthenticated.

`vercel.json` rewrites `/api/*` to Render, which keeps the API same-origin from
the browser's point of view — the same arrangement the Vite dev proxy provides
locally. That parity is deliberate: an auth bug that only appears in production
is a miserable thing to debug.

The alternative — `SameSite=None` cookies plus CORS credentials — works, but
widens CSRF exposure for no benefit here.

## What each rule in `vercel.json` is for

JSON has no comments and Vercel's schema rejects unknown keys — a `"comment"`
field fails validation outright, which is how the first deploy attempt was
rejected. So the reasoning lives here instead.

**Rewrites**, in order:

1. `/api/:path*` → Render. The proxy described above.
2. `/auth/google/callback` → Render. Google redirects the browser here after
   consent, and it must reach the API rather than the SPA — the handler
   exchanges the code for tokens and then redirects back into the app.
3. Everything else → `/index.html`. Client-side routing for `/privacy`,
   `/terms` and the app itself. Without it, refreshing on any path but `/`
   returns a CDN 404. The negative lookahead exempts real files —
   `assets/`, `icons/`, the manifest, the service worker, the offline page,
   the favicon and the link-preview image — which must be served as
   themselves, not as the SPA shell.

**Headers:**

- The security set applies everywhere. `X-Frame-Options: DENY` matters more
  than usual here: an app holding mailbox access should never be framed.
- `/assets/*` is cached forever because Vite fingerprints those filenames, so
  the content at a given URL never changes.
- `/sw.js` is explicitly *not* cached. A cached service worker cannot be
  replaced by a deploy, which strands users on an old shell indefinitely.

---

## 1. Turso

- [ ] Sign up at <https://turso.tech>
- [ ] Create a database named `hive`
- [ ] Copy the database URL (`libsql://hive-<org>.turso.io`) and create an
      auth token

Then apply the schema from your machine:

```bash
TURSO_DATABASE_URL=libsql://... TURSO_AUTH_TOKEN=... npm run db:migrate
```

Migrations are forward-only and recorded in a `_migrations` table, so running
this again after a later deploy applies only what is new.

**The server also applies them at boot**, so this step is a convenience rather
than a requirement. That was added after a deploy shipped code needing a table
nobody had created: the app failed at the point of use instead of at startup,
and the error it produced blamed Gmail rather than the schema. A migration
failure at boot is logged and the server still starts — refusing to boot over
a transient database hiccup would take the whole service down.

## 2. Resend

- [ ] Create an API key
- [ ] Add the domain `bee.harshitsaini.in`, add the DKIM and SPF records it
      gives you to Cloudflare, and wait for Verified

> Mail records must not be proxied. If Cloudflare shows an orange cloud on any
> of them, switch it to grey.

Until the domain verifies, sending fails outright — which means **nobody can
log in**, because login codes are the only way in. Verify this before opening
the app to anyone.

## 3. Generate the production secrets

Fresh values, not the ones from your `.env`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Once for `TOKEN_ENCRYPTION_KEY`, once for `SESSION_SECRET`.

> **Back up `TOKEN_ENCRYPTION_KEY` somewhere you will still have in a year.**
> It decrypts every stored Gmail token. Lose it and every connected account
> has to be reconnected; rotate it and the same thing happens immediately.

## 4. Render (API)

- [ ] New → Blueprint, point at this repository. It reads `render.yaml`.
- [ ] Render prompts for the secrets marked `sync: false`: the two Google
      credentials, both Turso values, the Resend key, and the two keys from
      step 3.
- [ ] Deploy, then confirm `https://<your-service>.onrender.com/health` returns
      `{"status":"ok","env":"production"}`
- [ ] Also check `/ready` — that one touches the database, so it proves the
      Turso credentials work.

**Note the free plan sleeps.** An idle instance spins down and the next request
waits ~50 seconds. More importantly, **cron does not run while asleep**, so
scheduled cleanup rules will fire late or not at all. Rules run hourly and
decide what is due from `last_run_at` in SQL, so nothing is skipped
permanently — it just drifts. Accept it, or move to a paid instance.

## 5. Vercel (web)

- [ ] Import the repository. It reads `vercel.json`.
- [ ] **Edit `vercel.json` first**: both rewrite destinations say
      `https://hive-api.onrender.com`. Change them to your actual Render URL,
      commit, then deploy.
- [ ] Add the domain `hive.harshitsaini.in` in Vercel and follow the DNS
      instructions it gives you.

## 6. Cloudflare

- [ ] Add the record Vercel asks for, pointing `hive` at Vercel
- [ ] Keep the Resend mail records unproxied (step 2)

## 7. Google Cloud

- [ ] Add `https://hive.harshitsaini.in/auth/google/callback` as an authorised
      redirect URI on the OAuth client
- [ ] Leave `https://localhost:3000/auth/google/callback` in place for local
      development — both can coexist
- [ ] Do **not** add any `http://` URI. A single one blocks the restricted
      scope for the whole project.

## 8. First run

- [ ] Load `https://hive.harshitsaini.in` — the landing page should appear
- [ ] Sign in. If no code arrives, Resend is the first place to look.
- [ ] Connect a Gmail account and run a search

---

## Verifying a deploy



Drives the deployed site in a real browser: landing page renders with no
console errors, theme switching works, the 404 screen appears on an unknown
path, and the privacy page is reachable. Point it elsewhere with
 — useful for checking a preview deployment before
promoting it.

That files are served correctly is not the same as the bundle running. Only a
browser distinguishes the two.

## Restoring the repo homepage

The GitHub homepage link was removed while the site was not live. Once it is:

```bash
gh repo edit harshitsaini-dev/hive --homepage "https://hive.harshitsaini.in"
```

## Keeping the API awake

Render's free plan spins an instance down after about 15 minutes of inactivity.
Two consequences, and the second is the one that matters:

1. The next request waits through a cold start — slow, but only cosmetic.
2. **Cron does not run while the instance is asleep.** Scheduled cleanup rules
   simply do not fire. They are not lost — `findDueRules` decides what is due
   from each rule's own `last_run_at` in SQL, so a rule that missed its window
   runs at the next tick after the instance wakes — but "daily" quietly becomes
   "whenever someone next opens the app".

Two independent pingers, because each covers the other's failure mode:

- **`.github/workflows/keepalive.yml`** — every 10 minutes. GitHub's scheduler
  is best-effort: runs are often late, sometimes skipped under load, and
  scheduled workflows are **disabled entirely after 60 days with no pushes to
  the repository**. Treat this as the backup.
- **UptimeRobot** — every 5 minutes from dedicated infrastructure, and it also
  tells you when the thing is actually down. This is the primary.

### Setting up UptimeRobot

1. Sign up at <https://uptimerobot.com> — the free plan allows 50 monitors at
   5-minute intervals.
2. **Add New Monitor**
   - Type: **HTTP(s)**
   - Friendly name: `Hive API`
   - URL: `https://hive.harshitsaini.in/api/health`
   - Interval: **5 minutes**
3. Add an alert contact (email is enough) so a real outage reaches you.
4. Optionally add a second monitor for `https://hive.harshitsaini.in/` — that
   one checks Vercel rather than Render, which is a different failure.

Point it at `/api/health`, not `/api/ready`: `ready` runs a database query, and
there is no reason to hit Turso every five minutes forever merely to keep a
process warm. Health checks liveness, which is what is being kept alive.

> **Do not monitor an endpoint that changes anything.** It is worth stating
> plainly given what this app can do: only `/health` and `/ready` are safe to
> poll. Everything else requires auth, and nothing that mutates mail should
> ever be on a timer that is not the cleanup scheduler.

### The cost this quietly incurs

Render's free tier bills **instance hours**, and the allowance at the time of
writing is 750 per month across the account. Keeping one service awake around
the clock uses roughly 730–744 hours in a 31-day month.

That fits — but with almost no headroom, and **a second free service would
blow straight past it**. Check the current allowance on Render's pricing page
before adding anything else, and decide then whether the tradeoff is still
worth it. Letting the instance sleep and accepting slow cold starts is a
perfectly reasonable alternative if scheduled rules are not being used.

## Known limitations of this topology

- **WebSockets do not survive the Vercel rewrite.** Nothing uses them yet —
  the bulk-trash progress bar is still unbuilt — but when it lands, the browser
  will need to connect to the Render origin directly, which means the session
  has to be carried some other way than a `SameSite=Lax` cookie.
- **The rate limiter is per-instance and in-memory.** Fine on a single Render
  instance; if that is ever scaled out, each instance enforces its own separate
  allowance. See `apps/server/src/middleware/rate-limit.ts`.
- **The server runs under `tsx`, not compiled output.** The workspace packages
  export TypeScript source so local tooling resolves without a build step, and
  Node cannot execute that directly. `tsx` is a runtime dependency for exactly
  this reason. If startup time ever matters, the fix is to build the packages
  to `dist` and switch their `exports` — not to add a bundler.

## Rollback

Both platforms keep previous deployments and can promote one instantly —
Render under Deploys, Vercel under Deployments. Neither reverses a database
migration, so a deploy that includes one needs a forward migration to undo it.
There are no destructive migrations so far.

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

## Restoring the repo homepage

The GitHub homepage link was removed while the site was not live. Once it is:

```bash
gh repo edit harshitsaini-dev/hive --homepage "https://hive.harshitsaini.in"
```

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

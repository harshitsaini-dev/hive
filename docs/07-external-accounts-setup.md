# External accounts — manual setup checklist

Everything here has to be done by a human in a browser. None of it can be
scripted. Work top to bottom; the Google Cloud section blocks all Gmail-facing
code, so do that one first.

Tick each box as you go, and paste the resulting values into `.env` (never
into git — `.env` is ignored, `.env.example` is the committed template).

---

## 1. Google Cloud — the blocking one

This is what lets Hive talk to Gmail at all. Budget ~20 minutes.

### 1a. Create the project
- [ ] Go to https://console.cloud.google.com/projectcreate
- [ ] Project name: `hive` (the generated project ID is fine)
- [ ] Create, then make sure `hive` is the selected project in the top bar —
      it is genuinely easy to configure the wrong project here

### 1b. Enable the Gmail API
- [ ] https://console.cloud.google.com/apis/library/gmail.googleapis.com
- [ ] Confirm `hive` is selected, click **Enable**

### 1c. OAuth consent screen
- [ ] https://console.cloud.google.com/auth/overview
- [ ] User type: **External** → Create
- [ ] App name: `Hive`
- [ ] User support email: `harshitsaini.dev@gmail.com`
- [ ] Developer contact email: same
- [ ] Save and continue

### 1d. Scopes
Add all four:
- [ ] `https://www.googleapis.com/auth/gmail.readonly`
- [ ] `https://www.googleapis.com/auth/gmail.modify`
- [ ] `https://www.googleapis.com/auth/gmail.send`
- [ ] `https://mail.google.com/` — **restricted**, required for permanent delete

> **The fourth one has consequences.** `https://mail.google.com/` is a
> restricted scope. In Testing mode (where this app lives) it is free and
> unremarkable. At public launch it triggers a CASA security assessment, which
> is sometimes a free self-assessment and sometimes a paid third-party audit.
> Read `docs/decisions/0002-permanent-delete.md` before submitting for
> verification — dropping this scope is the expected answer if CASA is not
> free, and the app degrades gracefully without it.

**Already created the client with only three scopes?** Add the fourth in the
console, then reconnect the account in Hive — Google only grants what was
consented to, so existing connections keep the old, narrower grant until they
go through consent again.

### 1e. Test users
While the app is unverified it runs in Testing mode, capped at 100 users.
- [ ] Add `harshitsaini.dev@gmail.com`
- [ ] Add a **second, throwaway Gmail account** to use as the test inbox —
      do not run destructive bulk-trash tests against an inbox you care about

### 1f. Create the OAuth client
- [ ] https://console.cloud.google.com/auth/clients → **Create client**
- [ ] Type: **Web application**
- [ ] Name: `Hive local dev`
- [ ] Authorised redirect URI: `https://localhost:3000/auth/google/callback`
- [ ] Create, then copy the **Client ID** and **Client secret**

> **HTTPS, including on localhost.** A project that requests a restricted scope
> may not have *any* `http://` redirect URI on *any* of its clients — Google
> greys out the restricted scopes and names the offending client. If you see
> that warning, the fix is to remove the `http://` URI entirely, not to add the
> HTTPS one alongside it.

### 1g. Local certificate

Because of the rule above, the dev servers run over TLS:

```bash
sh scripts/make-cert.sh
```

Then trust the generated CA, or every page load warns:

```powershell
certutil -user -addstore Root .certs\ca.crt
```

No administrator rights needed — it goes in your user store, which Chrome and
Edge both read. Firefox keeps its own: Settings → Privacy & Security →
Certificates → View Certificates → Authorities → Import `.certs/ca.crt`.

To undo: `certutil -user -delstore Root "Hive local development CA"`.

`.certs/` is gitignored. Anyone cloning the repo runs the script to get their
own — the certificate is per-machine and must never be committed.

Record them:
```
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
```

> The client secret is a real credential. It goes in `.env` only. If it ever
> lands in a commit, rotate it in the console rather than just deleting the
> line — git history keeps the old value.

---

## 2. Turso (database)
- [ ] Sign up at https://turso.tech — free tier, no card
- [ ] Create a database named `hive`
- [ ] Copy the database URL (`libsql://hive-<org>.turso.io`) and an auth token

```
TURSO_DATABASE_URL=libsql://...
TURSO_AUTH_TOKEN=...
```

## 3. Resend (OTP email)
- [ ] Sign up at https://resend.com — free tier, 3,000 emails/month
- [ ] Create an API key

```
RESEND_API_KEY=re_...
```

### Sender address

Logins send from `Bee <no-reply@bee.harshitsaini.in>`. A custom domain will
**not** send until it is verified in Resend:

- [ ] Resend dashboard → **Domains** → Add domain → `bee.harshitsaini.in`
- [ ] Resend gives you DKIM and SPF records — add them in Cloudflare DNS for
      `harshitsaini.in`. If Cloudflare shows an orange cloud toggle on any of
      them, turn proxying **off**; mail records must resolve directly.
- [ ] Wait for Resend to show the domain as Verified (usually minutes, but DNS
      can take up to a few hours)

Optional but worth doing before public launch: add a DMARC record
(`_dmarc.harshitsaini.in`, starting at `v=DMARC1; p=none;`). OTP mail that
lands in spam looks like a broken login, not a deliverability problem, so it
is worth getting right early.

Until the domain verifies, fall back to `OTP_FROM_ADDRESS=onboarding@resend.dev`
— it needs no DNS, but Resend only lets it deliver to the address that owns
the account, which is fine for solo development.

> Using a subdomain (`bee.`) rather than the root domain is the right call —
> it keeps sending reputation for this app separate from any other mail on
> `harshitsaini.in`.

## 4. Later — not needed to start coding
Deferred until the phases that actually need them:
- **Cloudflare** DNS for `hive.harshitsaini.in` — Phase 7/9
- **Vercel** (frontend) and **Render** (backend) deploys — Phase 9
- **Google Search Console** domain verification — Phase 7, required before
  submitting for OAuth verification

---

## When section 1 is done
Tell me, and I will wire up the OAuth connect flow. Per the master plan we get
**one real Gmail account connecting end-to-end** before building anything on
top of it — that single working round-trip de-risks more of this project than
any amount of scaffolding.

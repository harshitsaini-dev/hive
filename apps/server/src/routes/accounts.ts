import { Router } from 'express'
import { z } from 'zod'
import {
  deleteAccount,
  findAccountForOwner,
  listAccountsForOwner,
  listSyncStates,
  upsertAccount,
  writeAuditEntry,
} from '@hive/db'
import {
  buildAuthUrl,
  exchangeCodeForTokens,
  getProfile,
  ReauthRequiredError,
  type OAuthConfig,
} from '@hive/gmail-client'
import type { ConnectedAccount } from '@hive/shared-types'
import { config } from '../config.js'
import { decrypt, encrypt, randomToken, safeEqual } from '../crypto.js'
import { asyncRoute, badRequest, notFound } from '../errors.js'
import { authed, requireAuth } from '../middleware/auth.js'
import { syncAccount } from '../sync.js'

export const accountsRouter: Router = Router()

const oauth: OAuthConfig = {
  clientId: config.GOOGLE_CLIENT_ID,
  clientSecret: config.GOOGLE_CLIENT_SECRET,
  redirectUri: config.GOOGLE_REDIRECT_URI,
}

/**
 * CSRF protection for the OAuth round trip: a random value goes out in the
 * authorize URL and into a short-lived cookie, and the callback only proceeds
 * if they match. Without it, an attacker can complete the flow with their own
 * authorization code and silently attach their mailbox to someone's account.
 */
const OAUTH_STATE_COOKIE = 'hive_oauth_state'
const STATE_TTL_MS = 10 * 60_000

function toApiShape(row: {
  id: string
  gmail_address: string
  status: 'active' | 'reauth_required'
  connected_at: string
  last_synced_at: string | null
}): ConnectedAccount {
  return {
    id: row.id,
    gmailAddress: row.gmail_address,
    status: row.status,
    connectedAt: row.connected_at,
    lastSyncedAt: row.last_synced_at,
  }
}

/** GET /accounts — the caller's own connected mailboxes. */
accountsRouter.get(
  '/',
  requireAuth,
  asyncRoute(async (req, res) => {
    const rows = await listAccountsForOwner(authed(req).user.id)
    const states = await listSyncStates(rows.map((row) => row.id))
    const byAccount = new Map(states.map((state) => [state.account_id, state]))

    res.json({
      accounts: rows.map((row) => {
        const state = byAccount.get(row.id)

        return {
          ...toApiShape(row),
          /*
           * The index's own progress, separate from the account's OAuth
           * status. A mailbox can be perfectly connected and only a third
           * indexed, and conflating the two would either hide a working
           * account or claim a half-built index is ready.
           */
          sync: {
            indexed: state?.indexed_count ?? 0,
            estimate: state?.total_estimate ?? null,
            backfilling: state ? state.backfill_done === 0 : true,
            lastSyncedAt: state?.last_synced_at ?? null,
            error: state?.last_error ?? null,
          },
        }
      }),
    })
  }),
)

/**
 * POST /accounts/:id/sync — advance the index by one pass, now.
 *
 * One pass, not the whole mailbox: a backfill can take hours and a request
 * cannot. The hourly sweep does the rest, and pressing this again continues
 * from wherever the last pass stopped.
 */
accountsRouter.post(
  '/:id/sync',
  requireAuth,
  asyncRoute(async (req, res) => {
    const user = authed(req).user
    const account = (await listAccountsForOwner(user.id)).find(
      (row) => row.id === req.params.id,
    )
    if (!account) throw notFound('No such account')

    // Answered immediately; the pass carries on server-side. A pass is a
    // couple of thousand metadata reads and will outlive any sensible
    // request timeout.
    res.json({ started: true })

    void syncAccount(user.id, account).catch((error: unknown) => {
      console.error(`sync for ${account.id} failed:`, error)
    })
  }),
)

/**
 * GET /accounts/oauth/start
 *
 * Responds with the URL rather than redirecting, so the SPA can decide how to
 * navigate and so a failure is a readable JSON error instead of a redirect to
 * a Google error page.
 */
accountsRouter.get(
  '/oauth/start',
  requireAuth,
  asyncRoute(async (req, res) => {
    const state = randomToken(24)

    res.cookie(OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.isProduction,
      maxAge: STATE_TTL_MS,
      path: '/',
    })

    res.json({ url: buildAuthUrl(oauth, state) })
  }),
)

/**
 * POST /accounts/oauth/complete
 *
 * Finishes the connection using the `code` Google handed back.
 *
 * **Google does not call this.** Google redirects the *browser* to
 * GOOGLE_REDIRECT_URI, which is a page in the web app; that page then calls
 * this endpoint with a same-origin fetch.
 *
 * That indirection is the whole point. The obvious design — have Google
 * redirect straight to an API route — was tried first and failed in
 * production with a bare 401: arriving from accounts.google.com is a
 * cross-site top-level navigation, and the browser does not reliably attach a
 * `SameSite=Lax` session cookie to it. A same-origin XHR from a page the user
 * is already on carries both cookies without question.
 */
accountsRouter.post(
  '/oauth/complete',
  requireAuth,
  asyncRoute(async (req, res) => {
    const { user } = authed(req)
    const cookies = req.cookies as Record<string, string> | undefined
    const expectedState = cookies?.[OAUTH_STATE_COOKIE]

    const parsed = z
      .object({ code: z.string().min(1), state: z.string().min(1) })
      .safeParse(req.body)

    if (!parsed.success) throw badRequest('Malformed OAuth response')

    // CSRF: the state must match the cookie set when the flow began, so a
    // code obtained in someone else's browser cannot be redeemed here.
    if (!expectedState || !safeEqual(parsed.data.state, expectedState)) {
      res.clearCookie(OAUTH_STATE_COOKIE, { path: '/' })
      throw badRequest('That connection attempt expired. Start it again.')
    }

    res.clearCookie(OAUTH_STATE_COOKIE, { path: '/' })

    let tokens
    try {
      tokens = await exchangeCodeForTokens(oauth, parsed.data.code)
    } catch (error) {
      console.error('token exchange failed:', error)
      throw badRequest('Google would not complete the connection. Try again.')
    }

    // Ask Google which mailbox these tokens belong to rather than trusting
    // anything the client said — the address is the account's identity.
    let profile
    try {
      profile = await getProfile(tokens.accessToken)
    } catch (error) {
      console.error('profile lookup failed:', error)
      throw badRequest('Connected, but Google would not say which account.')
    }

    const account = await upsertAccount({
      ownerId: user.id,
      gmailAddress: profile.emailAddress,
      encryptedTokens: encrypt(JSON.stringify(tokens)),
    })

    await writeAuditEntry({
      userId: user.id,
      accountId: account.id,
      action: 'connect',
      details: { gmailAddress: profile.emailAddress },
    })

    res.json({ account: toApiShape(account) })
  }),
)

/** DELETE /accounts/:id — disconnect. Audited before the row disappears. */
accountsRouter.delete(
  '/:id',
  requireAuth,
  asyncRoute(async (req, res) => {
    const { user } = authed(req)
    const accountId = req.params.id
    if (!accountId) throw badRequest('Missing account id')

    const account = await findAccountForOwner(user.id, accountId)
    // Same answer for "does not exist" and "belongs to someone else", so the
    // endpoint cannot be used to probe for other people's account IDs.
    if (!account) throw notFound('No such connected account')

    await writeAuditEntry({
      userId: user.id,
      accountId: account.id,
      action: 'disconnect',
      details: { gmailAddress: account.gmail_address },
    })

    await deleteAccount(user.id, accountId)

    res.status(204).end()
  }),
)

/**
 * Reads and decrypts an account's tokens. Kept here so the decryption key is
 * used in exactly one place; route handlers never touch ciphertext.
 */
export async function loadAccountTokens(ownerId: string, accountId: string) {
  const account = await findAccountForOwner(ownerId, accountId)
  if (!account) throw notFound('No such connected account')

  try {
    return {
      account,
      tokens: JSON.parse(decrypt(account.encrypted_oauth_tokens)) as unknown,
    }
  } catch {
    // A row that will not decrypt means the key changed. Recoverable only by
    // reconnecting, so surface it as such rather than as a 500.
    throw new ReauthRequiredError('Stored credentials could not be read')
  }
}

import { Router } from 'express'
import {
  deleteAccount,
  findAccountForOwner,
  listAccountsForOwner,
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
    res.json({ accounts: rows.map(toApiShape) })
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
 * The OAuth callback.
 *
 * Exported rather than mounted on this router because its path is dictated by
 * GOOGLE_REDIRECT_URI — it has to match what is registered in the Google Cloud
 * console exactly. index.ts derives the mount point from that same variable so
 * the two cannot drift apart.
 *
 * Google redirects the browser here, so it responds with a redirect to the web
 * app rather than JSON — the user is looking at a page, not calling an API.
 *
 * `requireAuth` works despite the request originating from Google because the
 * session cookie is SameSite=Lax and this is a top-level GET navigation.
 */
export const oauthCallback = [
  requireAuth,
  asyncRoute(async (req, res) => {
    const { user } = authed(req)
    const cookies = req.cookies as Record<string, string> | undefined
    const expectedState = cookies?.[OAUTH_STATE_COOKIE]

    const clearState = () =>
      res.clearCookie(OAUTH_STATE_COOKIE, { path: '/' })

    const back = (params: Record<string, string>) => {
      const url = new URL('/accounts', config.WEB_ORIGIN)
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value)
      }
      clearState()
      res.redirect(url.toString())
    }

    // The user pressed Cancel, or Google refused the request.
    const errorParam = req.query.error
    if (typeof errorParam === 'string') {
      back({ connected: 'cancelled' })
      return
    }

    const code = req.query.code
    const state = req.query.state

    if (typeof code !== 'string' || typeof state !== 'string') {
      throw badRequest('Malformed OAuth callback')
    }
    if (!expectedState || !safeEqual(state, expectedState)) {
      throw badRequest('OAuth state mismatch — start the connection again')
    }

    let tokens
    try {
      tokens = await exchangeCodeForTokens(oauth, code)
    } catch (error) {
      console.error('token exchange failed:', error)
      back({ connected: 'failed' })
      return
    }

    // Ask Google which mailbox these tokens belong to rather than trusting
    // anything the client said — the address is the account's identity.
    let profile
    try {
      profile = await getProfile(tokens.accessToken)
    } catch (error) {
      console.error('profile lookup failed:', error)
      back({ connected: 'failed' })
      return
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

    back({ connected: 'ok', account: profile.emailAddress })
  }),
] as const

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

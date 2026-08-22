/**
 * Gmail API wrapper.
 *
 * Every Gmail call in the project goes through here. That is not just tidiness:
 * it is what makes the scope rule enforceable. If code elsewhere could build
 * its own requests, the rules about which operations are reachable would be
 * conventions rather than properties of the codebase. In particular,
 * permanent deletion lives in exactly one function (see ADR 0002).
 */
import { GMAIL_SCOPES } from '@hive/shared-types'

export { GMAIL_SCOPES }

const OAUTH_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'

export interface OAuthConfig {
  clientId: string
  clientSecret: string
  redirectUri: string
}

/**
 * The consent-screen URL.
 *
 * `access_type=offline` plus `prompt=consent` is what actually returns a
 * refresh token. Google only issues one on the first consent, so without
 * forcing the prompt a reconnect silently yields an access token that expires
 * in an hour and no way to renew it.
 */
export function buildAuthUrl(oauth: OAuthConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: oauth.clientId,
    redirect_uri: oauth.redirectUri,
    response_type: 'code',
    scope: GMAIL_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  })

  return `${OAUTH_AUTHORIZE_URL}?${params.toString()}`
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1'

export interface StoredTokens {
  accessToken: string
  /**
   * Google issues one only on first consent, which is why buildAuthUrl forces
   * `prompt=consent`. Absent it, there is no way to renew access and the
   * account is effectively read-once.
   */
  refreshToken: string
  /** Epoch milliseconds. */
  expiresAt: number
  scope: string
}

/** Raised when Google rejects the refresh token — the account needs reconnecting. */
export class ReauthRequiredError extends Error {
  constructor(message = 'Google rejected the stored credentials') {
    super(message)
    this.name = 'ReauthRequiredError'
  }
}

interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  scope: string
}

async function requestTokens(
  body: Record<string, string>,
): Promise<TokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    // invalid_grant means the refresh token is revoked or expired — the
    // seven-day Testing-mode expiry lands here, and it is recoverable only by
    // sending the user back through consent.
    if (response.status === 400 && detail.includes('invalid_grant')) {
      throw new ReauthRequiredError()
    }
    throw new Error(`Google token endpoint returned ${response.status}: ${detail}`)
  }

  return (await response.json()) as TokenResponse
}

/** Exchanges the one-time code from the OAuth callback for tokens. */
export async function exchangeCodeForTokens(
  oauth: OAuthConfig,
  code: string,
): Promise<StoredTokens> {
  const tokens = await requestTokens({
    code,
    client_id: oauth.clientId,
    client_secret: oauth.clientSecret,
    redirect_uri: oauth.redirectUri,
    grant_type: 'authorization_code',
  })

  if (!tokens.refresh_token) {
    // Without this the connection is useless within the hour. Almost always
    // means prompt=consent was dropped from the authorize URL.
    throw new Error(
      'Google returned no refresh token — the authorize URL must use prompt=consent.',
    )
  }

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    scope: tokens.scope,
  }
}

/** A minute of slack, so a token does not expire mid-request. */
const EXPIRY_SKEW_MS = 60_000

export function isExpired(tokens: StoredTokens, now = Date.now()): boolean {
  return now >= tokens.expiresAt - EXPIRY_SKEW_MS
}

/**
 * Returns tokens valid right now, refreshing if needed. Google does not
 * re-issue the refresh token on renewal, so the existing one is carried
 * forward.
 */
export async function ensureFreshTokens(
  oauth: OAuthConfig,
  tokens: StoredTokens,
): Promise<{ tokens: StoredTokens; refreshed: boolean }> {
  if (!isExpired(tokens)) return { tokens, refreshed: false }

  const renewed = await requestTokens({
    client_id: oauth.clientId,
    client_secret: oauth.clientSecret,
    refresh_token: tokens.refreshToken,
    grant_type: 'refresh_token',
  })

  return {
    refreshed: true,
    tokens: {
      accessToken: renewed.access_token,
      refreshToken: renewed.refresh_token ?? tokens.refreshToken,
      expiresAt: Date.now() + renewed.expires_in * 1000,
      scope: renewed.scope || tokens.scope,
    },
  }
}

export interface GmailProfile {
  emailAddress: string
  messagesTotal: number
  historyId: string
}

/** Which mailbox a set of tokens actually belongs to. */
export async function getProfile(accessToken: string): Promise<GmailProfile> {
  const response = await fetch(`${GMAIL_API}/users/me/profile`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  if (response.status === 401) throw new ReauthRequiredError()
  if (!response.ok) {
    throw new Error(`Gmail profile request failed (${response.status})`)
  }

  return (await response.json()) as GmailProfile
}

/**
 * Gmail's own limit for batchModify is 1000 IDs per call, so bulk work is
 * chunked. Exported because the progress reporting needs the same number to
 * calculate how many calls a job will take.
 */
export const BATCH_MODIFY_LIMIT = 1000

export function chunk<T>(items: readonly T[], size = BATCH_MODIFY_LIMIT): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

/**
 * Gmail's history only reaches back roughly 30 days. Past that a stored
 * historyId is worthless and the account must be re-indexed in full — which
 * is the normal outcome of any account that sat in `reauth_required` for a
 * while, not a rare edge case.
 */
export const HISTORY_HORIZON_DAYS = 30

export function isHistoryUsable(lastSyncedAt: Date | null, now = new Date()): boolean {
  if (!lastSyncedAt) return false
  const elapsedDays = (now.getTime() - lastSyncedAt.getTime()) / 86_400_000
  return elapsedDays < HISTORY_HORIZON_DAYS
}

export * from './messages.js'

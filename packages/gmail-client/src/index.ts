/**
 * Gmail API wrapper.
 *
 * Every Gmail call in the project goes through here. That is not just tidiness:
 * it is what makes the scope rule enforceable. If code elsewhere could build
 * its own requests, "we only ever trash" would be a convention rather than a
 * property of the codebase.
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

// Implemented in Phase 1 onward: token exchange and refresh, listMessages,
// getMessage, trashMessages (batchModify — never batchDelete, see ADR 0001),
// sendMessage, and history-based incremental sync.

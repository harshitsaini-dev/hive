/**
 * Types shared across the client/server boundary.
 *
 * Anything here is part of the API contract — changing a field is a breaking
 * change for the web app, so treat edits with the same care as a migration.
 */

/**
 * The three scopes the hosted product requests, and the only three it may.
 *
 * Adding `https://mail.google.com/` pulls the app into a CASA security
 * assessment — see docs/decisions/0001-trash-not-permanent-delete.md. This
 * array is the single source of truth for the OAuth request; do not build
 * scope strings anywhere else.
 */
export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
] as const

export type GmailScope = (typeof GMAIL_SCOPES)[number]

/**
 * `reauth_required` means Google rejected the stored refresh token — usually
 * because the app is still unverified and Testing-mode tokens expire after
 * seven days. It is an expected state, not an error state, and the UI must
 * surface it rather than silently failing syncs.
 */
export type AccountStatus = 'active' | 'reauth_required'

export interface ConnectedAccount {
  id: string
  gmailAddress: string
  status: AccountStatus
  connectedAt: string
  lastSyncedAt: string | null
}

export interface MessageSummary {
  id: string
  accountId: string
  gmailMessageId: string
  threadId: string
  from: string
  subject: string
  /** Gmail's own short preview. Never the full body — bodies are not stored. */
  snippet: string
  labels: string[]
  receivedAt: string
}

/** Cleanup rules only ever trash. See ADR 0001. */
export type CleanupAction = 'trash'
export type CleanupSchedule = 'manual' | 'daily' | 'weekly'

export interface CleanupRule {
  id: string
  accountId: string
  /** Gmail search syntax, e.g. `category:promotions older_than:30d`. */
  query: string
  action: CleanupAction
  schedule: CleanupSchedule
  lastRunAt: string | null
}

export type AuditAction =
  | 'connect'
  | 'disconnect'
  | 'trash'
  | 'send'
  | 'rule_run'

export interface AuditEntry {
  id: string
  accountId: string | null
  action: AuditAction
  details: Record<string, unknown>
  createdAt: string
}

/** Progress frames pushed over the WebSocket during a bulk trash. */
export interface BulkProgress {
  jobId: string
  processed: number
  total: number
  done: boolean
  error?: string
}

/**
 * Every error response uses this shape, so the client has exactly one thing
 * to parse. `message` is safe to show a user; internals never go in it.
 */
export interface ApiError {
  error: {
    code: string
    message: string
    details?: unknown
  }
}

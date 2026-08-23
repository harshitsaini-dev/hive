import type { ApiError, ConnectedAccount } from '@hive/shared-types'

export interface User {
  id: string
  email: string
}

/** Carries the server's message so the UI can show it verbatim. */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiRequestError'
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    // Sessions are cookie-based, so every call has to carry them.
    credentials: 'include',
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })

  if (response.status === 204) return undefined as T

  const body: unknown = await response.json().catch(() => null)

  if (!response.ok) {
    const parsed = body as ApiError | null
    throw new ApiRequestError(
      response.status,
      parsed?.error?.code ?? 'unknown',
      parsed?.error?.message ?? 'Something went wrong.',
    )
  }

  return body as T
}

export interface MessageRow {
  gmailMessageId: string
  threadId: string
  accountId: string
  gmailAddress: string
  from: string
  subject: string
  snippet: string
  labels: string[]
  receivedAt: string
}

export interface SearchResult {
  messages: MessageRow[]
  /** Opaque; hand it straight back to fetch the next page. Null at the end. */
  nextPageToken: string | null
  /** Per-account outcome, so one failing mailbox can be named rather than
   *  failing the whole search. */
  accounts: { accountId: string; gmailAddress: string; error: string | null }[]
  skipped: { accountId: string; gmailAddress: string; reason: string }[]
}

export interface MessageAttachment {
  attachmentId: string
  filename: string
  mimeType: string
  size: number
  /** Set when the body embeds this file with `src="cid:…"` rather than
   *  attaching it at the bottom. */
  contentId?: string
}

export interface ParsedMessage {
  id: string
  threadId: string
  subject: string
  from: string
  to: string
  cc: string
  date: string
  labels: string[]
  snippet: string
  text: string | null
  /** Untrusted sender markup. Only ever rendered in a sandboxed frame. */
  html: string | null
  attachments: MessageAttachment[]
}

export interface BulkJob {
  id: string
  action: 'trash' | 'restore' | 'delete_forever'
  total: number
  processed: number
  status: 'running' | 'done' | 'failed'
  error: string | null
}

/** A bulk call answers with a job when it was asked to run in the background. */
export type BulkResult = { jobId: string } | { done: number }

export interface CleanupRule {
  id: string
  accountId: string
  query: string
  /** Always 'trash' — rules cannot delete permanently. */
  action: 'trash'
  schedule: 'manual' | 'daily' | 'weekly'
  enabled: boolean
  lastRunAt: string | null
}

export const api = {
  requestCode: (email: string) =>
    request<{ sent: true; expiresInMinutes: number }>('/auth/otp/request', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),

  verifyCode: (email: string, code: string) =>
    request<{ user: User }>('/auth/otp/verify', {
      method: 'POST',
      body: JSON.stringify({ email, code }),
    }),

  me: () => request<{ user: User }>('/auth/me'),

  logout: () => request<void>('/auth/logout', { method: 'POST' }),

  listAccounts: () =>
    request<{ accounts: ConnectedAccount[] }>('/accounts'),

  startConnect: () => request<{ url: string }>('/accounts/oauth/start'),

  /**
   * Redeems the code Google handed back. Same-origin on purpose — see
   * OAuthCallbackView for why Google is not pointed at the API directly.
   */
  completeConnect: (code: string, state: string) =>
    request<{ account: ConnectedAccount }>('/accounts/oauth/complete', {
      method: 'POST',
      body: JSON.stringify({ code, state }),
    }),

  disconnect: (id: string) =>
    request<void>(`/accounts/${id}`, { method: 'DELETE' }),

  searchMessages: (options: {
    q?: string
    accountId?: string
    pageSize?: number
    pageToken?: string
  }) => {
    const params = new URLSearchParams()
    if (options.q) params.set('q', options.q)
    if (options.accountId) params.set('accountId', options.accountId)
    if (options.pageSize) params.set('pageSize', String(options.pageSize))
    if (options.pageToken) params.set('pageToken', options.pageToken)
    return request<SearchResult>(`/messages?${params.toString()}`)
  },

  /**
   * Every message ID a query matches, not just the visible page.
   *
   * Returns a real count so a confirmation can state one, and `truncated` when
   * the query matched more than the server's per-action cap — the UI has to
   * say so, or the user believes the action covered everything.
   */
  resolveQuery: (accountId: string, query: string) =>
    request<{
      messageIds: string[]
      count: number
      truncated: boolean
      limit: number
    }>('/messages/resolve-query', {
      method: 'POST',
      body: JSON.stringify({ accountId, query }),
    }),

  getMessage: (accountId: string, messageId: string) => {
    const params = new URLSearchParams({ accountId })
    return request<{ message: ParsedMessage }>(
      `/messages/${messageId}?${params.toString()}`,
    )
  },

  /**
   * A plain URL rather than a fetch: the browser downloads it directly, so a
   * large attachment never passes through JavaScript memory.
   */
  attachmentUrl: (
    accountId: string,
    messageId: string,
    attachmentId: string,
    filename: string,
    /**
     * Ask for it rendered rather than downloaded. Only honoured when the bytes
     * really are a raster image — the server decides, not this flag.
     */
    inline = false,
  ) => {
    const params = new URLSearchParams({ accountId, filename })
    if (inline) params.set('inline', '1')
    return `/api/messages/${messageId}/attachments/${attachmentId}?${params.toString()}`
  },

  /**
   * With `background`, the server answers with a job id and keeps working —
   * the only way to show progress, since a synchronous response arrives once,
   * at the end.
   */
  trashMessages: (accountId: string, messageIds: string[], background = false) =>
    request<{ trashed?: number; jobId?: string }>('/messages/trash', {
      method: 'POST',
      body: JSON.stringify({ accountId, messageIds, background }),
    }),

  restoreMessages: (accountId: string, messageIds: string[], background = false) =>
    request<{ restored?: number; jobId?: string }>('/messages/restore', {
      method: 'POST',
      body: JSON.stringify({ accountId, messageIds, background }),
    }),

  getJob: (id: string) => request<BulkJob>(`/messages/jobs/${id}`),

  /**
   * Irreversible. The confirmation phrase is required by the server too, so no
   * client can reach this endpoint by reshaping a trash request.
   */
  deleteForever: (accountId: string, messageIds: string[], background = false) =>
    request<{ deleted?: number; jobId?: string }>('/messages/delete-forever', {
      method: 'POST',
      body: JSON.stringify({
        accountId,
        messageIds,
        background,
        confirm: 'permanently delete',
      }),
    }),

  sendMessage: (message: {
    accountId: string
    to: string
    subject: string
    body: string
    attachments?: { filename: string; mimeType: string; base64: string }[]
  }) =>
    request<{ id: string; threadId: string }>('/messages/send', {
      method: 'POST',
      body: JSON.stringify(message),
    }),

  listRules: () => request<{ rules: CleanupRule[] }>('/rules'),

  /**
   * No `action` field: rules always trash. The server does not accept one,
   * so a scheduled permanent deletion cannot be created by any request.
   */
  createRule: (rule: {
    accountId: string
    query: string
    schedule: 'manual' | 'daily' | 'weekly'
  }) =>
    request<{ rule: CleanupRule }>('/rules', {
      method: 'POST',
      body: JSON.stringify(rule),
    }),

  runRule: (id: string) =>
    request<{ trashed: number; truncated: boolean }>(`/rules/${id}/run`, {
      method: 'POST',
    }),

  setRuleEnabled: (id: string, enabled: boolean) =>
    request<void>(`/rules/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }),

  deleteRule: (id: string) =>
    request<void>(`/rules/${id}`, { method: 'DELETE' }),
}

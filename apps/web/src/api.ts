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
  /** Per-account outcome, so one failing mailbox can be named rather than
   *  failing the whole search. */
  accounts: { accountId: string; gmailAddress: string; error: string | null }[]
  skipped: { accountId: string; gmailAddress: string; reason: string }[]
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

  disconnect: (id: string) =>
    request<void>(`/accounts/${id}`, { method: 'DELETE' }),

  searchMessages: (options: { q?: string; accountId?: string }) => {
    const params = new URLSearchParams()
    if (options.q) params.set('q', options.q)
    if (options.accountId) params.set('accountId', options.accountId)
    return request<SearchResult>(`/messages?${params.toString()}`)
  },

  trashMessages: (accountId: string, messageIds: string[]) =>
    request<{ trashed: number }>('/messages/trash', {
      method: 'POST',
      body: JSON.stringify({ accountId, messageIds }),
    }),

  restoreMessages: (accountId: string, messageIds: string[]) =>
    request<{ restored: number }>('/messages/restore', {
      method: 'POST',
      body: JSON.stringify({ accountId, messageIds }),
    }),

  /**
   * Irreversible. The confirmation phrase is required by the server too, so no
   * client can reach this endpoint by reshaping a trash request.
   */
  deleteForever: (accountId: string, messageIds: string[]) =>
    request<{ deleted: number }>('/messages/delete-forever', {
      method: 'POST',
      body: JSON.stringify({
        accountId,
        messageIds,
        confirm: 'permanently delete',
      }),
    }),
}

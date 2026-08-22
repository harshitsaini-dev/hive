/**
 * Message reading, searching, trashing and sending.
 *
 * Split from index.ts, which owns OAuth. Everything here takes an access token
 * that the caller has already ensured is fresh.
 */
import { chunk, ReauthRequiredError } from './index.js'

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1'

async function gmailFetch(
  accessToken: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const response = await fetch(`${GMAIL_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })

  if (response.status === 401) throw new ReauthRequiredError()

  return response
}

async function gmailJson<T>(
  accessToken: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await gmailFetch(accessToken, path, init)

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Gmail ${path} failed (${response.status}): ${detail}`)
  }

  return (await response.json()) as T
}

export interface MessageRef {
  id: string
  threadId: string
}

export interface MessageListPage {
  messages: MessageRef[]
  nextPageToken?: string
  resultSizeEstimate?: number
}

/**
 * One page of search results. `query` takes Gmail's own syntax and is passed
 * through untouched — reimplementing it would be worse than what users already
 * know from Gmail itself.
 */
export async function listMessages(
  accessToken: string,
  options: { query?: string; pageToken?: string; maxResults?: number } = {},
): Promise<MessageListPage> {
  const params = new URLSearchParams({
    maxResults: String(options.maxResults ?? 100),
  })
  if (options.query) params.set('q', options.query)
  if (options.pageToken) params.set('pageToken', options.pageToken)

  const page = await gmailJson<MessageListPage>(
    accessToken,
    `/users/me/messages?${params.toString()}`,
  )

  // Gmail omits `messages` entirely when nothing matches, rather than
  // returning an empty array.
  return { ...page, messages: page.messages ?? [] }
}

/**
 * Walks every page of a search.
 *
 * `limit` is required rather than optional: a bulk action over an unbounded
 * result set could page through a hundred thousand messages, and the caller
 * should always have decided what is reasonable first.
 */
export async function listAllMessageIds(
  accessToken: string,
  query: string,
  limit: number,
): Promise<{ ids: string[]; truncated: boolean }> {
  const ids: string[] = []
  let pageToken: string | undefined

  do {
    const page = await listMessages(accessToken, {
      query,
      pageToken,
      maxResults: Math.min(500, limit - ids.length),
    })

    for (const message of page.messages) {
      if (ids.length >= limit) return { ids, truncated: true }
      ids.push(message.id)
    }

    pageToken = page.nextPageToken
  } while (pageToken && ids.length < limit)

  return { ids, truncated: Boolean(pageToken) }
}

interface RawHeader {
  name: string
  value: string
}

interface RawMessage {
  id: string
  threadId: string
  labelIds?: string[]
  snippet?: string
  internalDate?: string
  payload?: { headers?: RawHeader[] }
}

export interface MessageMetadata {
  gmailMessageId: string
  threadId: string
  from: string
  subject: string
  snippet: string
  labels: string[]
  receivedAt: Date
}

function header(headers: RawHeader[] | undefined, name: string): string {
  const match = headers?.find(
    (candidate) => candidate.name.toLowerCase() === name.toLowerCase(),
  )
  return match?.value ?? ''
}

/**
 * Metadata only, via `format=metadata` and an explicit header allowlist.
 *
 * This is not just an optimisation. Asking for `format=full` would pull down
 * message bodies, and the project's privacy claim is that bodies are never
 * fetched during indexing. Keeping the format narrow makes that true on the
 * wire, not merely in policy.
 */
export async function getMessageMetadata(
  accessToken: string,
  messageId: string,
): Promise<MessageMetadata> {
  const params = new URLSearchParams({ format: 'metadata' })
  for (const name of ['From', 'Subject', 'Date']) {
    params.append('metadataHeaders', name)
  }

  const raw = await gmailJson<RawMessage>(
    accessToken,
    `/users/me/messages/${messageId}?${params.toString()}`,
  )

  return {
    gmailMessageId: raw.id,
    threadId: raw.threadId,
    from: header(raw.payload?.headers, 'From'),
    subject: header(raw.payload?.headers, 'Subject'),
    snippet: raw.snippet ?? '',
    labels: raw.labelIds ?? [],
    // internalDate is epoch millis as a string, and is what Gmail sorts by.
    receivedAt: new Date(Number(raw.internalDate ?? Date.now())),
  }
}

/**
 * The full message, body included. Called only when a user opens something —
 * never during indexing, and the result is never written to the database.
 */
export async function getMessageFull(
  accessToken: string,
  messageId: string,
): Promise<unknown> {
  return gmailJson(accessToken, `/users/me/messages/${messageId}?format=full`)
}

/**
 * Moves messages to Trash.
 *
 * This is the default removal path and what every bulk action and cleanup
 * rule uses: reversible, recoverable for thirty days. Permanent deletion is a
 * separate, explicit action in the Trash view — see ADR 0002.
 */
export async function trashMessages(
  accessToken: string,
  messageIds: readonly string[],
  onProgress?: (processed: number, total: number) => void,
): Promise<void> {
  let processed = 0

  for (const batch of chunk(messageIds)) {
    const response = await gmailFetch(
      accessToken,
      '/users/me/messages/batchModify',
      {
        method: 'POST',
        body: JSON.stringify({
          ids: batch,
          addLabelIds: ['TRASH'],
          removeLabelIds: ['INBOX'],
        }),
      },
    )

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`batchModify failed (${response.status}): ${detail}`)
    }

    processed += batch.length
    onProgress?.(processed, messageIds.length)
  }
}

/** Encodes an RFC 2822 message the way Gmail's send endpoint expects. */
export function buildRawMessage(params: {
  from: string
  to: string
  subject: string
  body: string
}): string {
  const encodedSubject = Buffer.from(params.subject, 'utf8').toString('base64')

  const lines = [
    `From: ${params.from}`,
    `To: ${params.to}`,
    // Non-ASCII subjects must be encoded or they arrive as mojibake.
    `Subject: =?UTF-8?B?${encodedSubject}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    params.body,
  ]

  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url')
}

export async function sendMessage(
  accessToken: string,
  raw: string,
): Promise<{ id: string; threadId: string }> {
  return gmailJson(accessToken, '/users/me/messages/send', {
    method: 'POST',
    body: JSON.stringify({ raw }),
  })
}

export interface HistoryPage {
  history?: {
    messagesAdded?: { message: MessageRef }[]
    messagesDeleted?: { message: MessageRef }[]
  }[]
  historyId?: string
  nextPageToken?: string
}

export interface HistoryResult {
  added: MessageRef[]
  removed: MessageRef[]
  historyId: string | null
  /** True when Gmail rejected the cursor and a full re-index is required. */
  expired: boolean
}

/**
 * Changes since `startHistoryId`.
 *
 * Gmail keeps roughly 30 days of history. Past that it answers 404 — which is
 * not an error to surface but an instruction: discard the cursor and re-index
 * in full. Any account that sat in `reauth_required` for a month lands here,
 * so this is a normal path rather than an edge case.
 */
export async function listHistory(
  accessToken: string,
  startHistoryId: string,
): Promise<HistoryResult> {
  const added: MessageRef[] = []
  const removed: MessageRef[] = []
  let historyId: string | null = null
  let pageToken: string | undefined

  do {
    const params = new URLSearchParams({ startHistoryId })
    if (pageToken) params.set('pageToken', pageToken)

    const response = await gmailFetch(
      accessToken,
      `/users/me/history?${params.toString()}`,
    )

    if (response.status === 404) {
      return { added: [], removed: [], historyId: null, expired: true }
    }
    if (!response.ok) {
      throw new Error(`history.list failed (${response.status})`)
    }

    const page = (await response.json()) as HistoryPage

    for (const entry of page.history ?? []) {
      for (const item of entry.messagesAdded ?? []) added.push(item.message)
      for (const item of entry.messagesDeleted ?? []) removed.push(item.message)
    }

    historyId = page.historyId ?? historyId
    pageToken = page.nextPageToken
  } while (pageToken)

  return { added, removed, historyId, expired: false }
}

/* ---- the Trash bin ------------------------------------------------------- */

/**
 * Moves messages back out of Trash.
 *
 * `untrash` is per-message rather than batched — Gmail offers no batch
 * equivalent — so this is sequential and slower than trashing. Acceptable:
 * restoring is a considered action over a handful of messages, not a sweep.
 */
export async function untrashMessages(
  accessToken: string,
  messageIds: readonly string[],
  onProgress?: (processed: number, total: number) => void,
): Promise<void> {
  let processed = 0

  for (const id of messageIds) {
    const response = await gmailFetch(
      accessToken,
      `/users/me/messages/${id}/untrash`,
      { method: 'POST' },
    )

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`untrash failed for ${id} (${response.status}): ${detail}`)
    }

    processed += 1
    onProgress?.(processed, messageIds.length)
  }
}

/**
 * Permanently deletes messages. There is no undo.
 *
 * Requires the restricted `https://mail.google.com/` scope — see ADR 0002.
 * Nothing in this codebase may call this on a schedule or as a default action:
 * it is reachable only from an explicit, type-to-confirm user gesture in the
 * Trash view.
 *
 * Gmail returns 204 with no body on success.
 */
export async function permanentlyDeleteMessages(
  accessToken: string,
  messageIds: readonly string[],
  onProgress?: (processed: number, total: number) => void,
): Promise<void> {
  let processed = 0

  for (const batch of chunk(messageIds)) {
    const response = await gmailFetch(
      accessToken,
      '/users/me/messages/batchDelete',
      { method: 'POST', body: JSON.stringify({ ids: batch }) },
    )

    if (response.status === 403) {
      // The restricted scope was not granted, or was withdrawn.
      throw new ScopeNotGrantedError()
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`batchDelete failed (${response.status}): ${detail}`)
    }

    processed += batch.length
    onProgress?.(processed, messageIds.length)
  }
}

/** Raised when an action needs a scope the user did not grant. */
export class ScopeNotGrantedError extends Error {
  constructor(message = 'This account has not granted permission for that') {
    super(message)
    this.name = 'ScopeNotGrantedError'
  }
}

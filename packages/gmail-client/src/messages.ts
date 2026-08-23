/**
 * Message reading, searching, trashing and sending.
 *
 * Split from index.ts, which owns OAuth. Everything here takes an access token
 * that the caller has already ensured is fresh.
 */
import { chunk, ReauthRequiredError } from './index.js'

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1'

/**
 * Gmail's per-minute quota, exhausted. Its own kind because the caller has a
 * useful thing to say about it — wait and try again, fewer at a time — which
 * is lost if it arrives as a generic failure carrying Google's raw JSON.
 */
export class RateLimitedError extends Error {
  constructor() {
    super('Gmail is rate limiting this account. Wait a minute and try again.')
    this.name = 'RateLimitedError'
  }
}

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

/**
 * Gmail reports a per-minute quota breach two different ways: a 429, and a 403
 * whose body says `rateLimitExceeded`. The 403 is the surprising one — it
 * reads like a permission problem and was surfaced to users as one, wrapped in
 * a wall of Google's JSON, when all that had happened was asking too quickly.
 */
function isRateLimited(status: number, body: string): boolean {
  if (status === 429) return true
  return (
    status === 403 &&
    /rateLimitExceeded|userRateLimitExceeded|Quota exceeded/i.test(body)
  )
}

const MAX_ATTEMPTS = 4

async function gmailJson<T>(
  accessToken: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const response = await gmailFetch(accessToken, path, init)

    if (response.ok) return (await response.json()) as T

    const detail = await response.text().catch(() => '')

    /*
     * Backing off is the whole remedy: the quota is per minute, so waiting is
     * what makes the next attempt work. Retrying immediately would only spend
     * more of the quota that has already run out.
     */
    if (isRateLimited(response.status, detail) && attempt < MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 500))
      continue
    }

    if (isRateLimited(response.status, detail)) {
      throw new RateLimitedError()
    }

    throw new Error(`Gmail ${path} failed (${response.status}): ${detail}`)
  }
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

export interface OutgoingAttachment {
  filename: string
  mimeType: string
  /** The file's bytes, base64 encoded. */
  base64: string
}

/** RFC 2047: any header value with non-ASCII has to be encoded, or it arrives as mojibake. */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(value)) return value
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

/** Base64 in a MIME body must be wrapped, or some servers reject the line length. */
function wrap76(base64: string): string {
  return (base64.match(/.{1,76}/g) ?? []).join('\r\n')
}

/**
 * Strips anything that could break out of the header.
 *
 * A newline in a filename or address would let the caller inject arbitrary
 * MIME headers — a `Bcc:` of their choosing, for instance. The values here
 * come from a form, so this is not theoretical.
 */
function headerSafe(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim()
}

/**
 * Encodes an RFC 2822 message the way Gmail's send endpoint expects.
 *
 * Plain text when there are no attachments, `multipart/mixed` when there are —
 * a multipart envelope around a lone text part is legal but makes every client
 * show a paperclip for a message with nothing attached.
 */
export function buildRawMessage(params: {
  from: string
  to: string
  subject: string
  body: string
  attachments?: OutgoingAttachment[]
}): string {
  const attachments = params.attachments ?? []

  const headers = [
    `From: ${headerSafe(params.from)}`,
    `To: ${headerSafe(params.to)}`,
    `Subject: ${encodeHeader(headerSafe(params.subject))}`,
    'MIME-Version: 1.0',
  ]

  if (attachments.length === 0) {
    return Buffer.from(
      [...headers, 'Content-Type: text/plain; charset="UTF-8"', '', params.body].join(
        '\r\n',
      ),
      'utf8',
    ).toString('base64url')
  }

  // Long and random enough that it cannot occur inside the content it delimits.
  const boundary = `hive_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`

  const parts: string[] = [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    params.body,
  ]

  for (const attachment of attachments) {
    const filename = headerSafe(attachment.filename) || 'attachment'

    parts.push(
      `--${boundary}`,
      `Content-Type: ${headerSafe(attachment.mimeType) || 'application/octet-stream'}; name="${filename}"`,
      `Content-Disposition: attachment; filename="${filename}"`,
      'Content-Transfer-Encoding: base64',
      '',
      wrap76(attachment.base64),
    )
  }

  parts.push(`--${boundary}--`, '')

  return Buffer.from(parts.join('\r\n'), 'utf8').toString('base64url')
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
    labelsAdded?: { message: MessageRef; labelIds?: string[] }[]
    labelsRemoved?: { message: MessageRef; labelIds?: string[] }[]
  }[]
  historyId?: string
  nextPageToken?: string
}

export interface HistoryResult {
  added: MessageRef[]
  removed: MessageRef[]
  /**
   * Messages whose labels changed — including everything moved to or out of
   * Trash.
   *
   * Originally missing, and the omission was not harmless. Trashing a message
   * does not delete it; it swaps `INBOX` for `TRASH`, which arrives as a
   * label change and nothing else. An index that ignored those kept showing
   * mail in the inbox that had been thrown away — from Gmail's own UI, and
   * from Hive itself.
   */
  changed: MessageRef[]
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
  const changed: MessageRef[] = []
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
      return {
        added: [],
        removed: [],
        changed: [],
        historyId: null,
        expired: true,
      }
    }
    if (!response.ok) {
      throw new Error(`history.list failed (${response.status})`)
    }

    const page = (await response.json()) as HistoryPage

    for (const entry of page.history ?? []) {
      for (const item of entry.messagesAdded ?? []) added.push(item.message)
      for (const item of entry.messagesDeleted ?? []) removed.push(item.message)

      /*
       * Which labels changed is not recorded, only that they did. Re-reading
       * the message is the reliable answer — working out the new label set by
       * applying a stream of additions and removals in order is the kind of
       * cleverness that is wrong once and then wrong forever.
       */
      for (const item of entry.labelsAdded ?? []) changed.push(item.message)
      for (const item of entry.labelsRemoved ?? []) changed.push(item.message)
    }

    historyId = page.historyId ?? historyId
    pageToken = page.nextPageToken
  } while (pageToken)

  return { added, removed, changed, historyId, expired: false }
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

/**
 * Downloads one attachment's bytes.
 *
 * Returned as a base64url string, exactly as Gmail sends it — decoding here
 * would mean holding the whole file as a Buffer twice on the way through.
 */
export async function getAttachment(
  accessToken: string,
  messageId: string,
  attachmentId: string,
): Promise<{ data: string; size: number }> {
  return gmailJson(
    accessToken,
    `/users/me/messages/${messageId}/attachments/${attachmentId}`,
  )
}

/**
 * The display name Gmail itself puts on outgoing mail.
 *
 * Without this, messages sent through Hive arrive showing a bare address
 * while the same person's mail sent from Gmail shows their name — the two
 * look like different senders, which is exactly the wrong impression for an
 * app that sends on someone's behalf.
 *
 * Reads the default send-as alias. Requires the settings read that the
 * restricted scope already grants; returns null rather than throwing, since a
 * missing display name must never block a send.
 */
export async function getSendAsDisplayName(
  accessToken: string,
  emailAddress: string,
): Promise<string | null> {
  try {
    const response = await gmailFetch(accessToken, '/users/me/settings/sendAs')
    if (!response.ok) return null

    const body = (await response.json()) as {
      sendAs?: { sendAsEmail?: string; displayName?: string; isDefault?: boolean }[]
    }

    const aliases = body.sendAs ?? []
    const match =
      aliases.find((alias) => alias.isDefault) ??
      aliases.find(
        (alias) =>
          alias.sendAsEmail?.toLowerCase() === emailAddress.toLowerCase(),
      )

    return match?.displayName?.trim() || null
  } catch {
    return null
  }
}

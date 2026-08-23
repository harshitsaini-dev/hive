/**
 * Gmail's batch endpoint.
 *
 * Fetching metadata for a page of 500 messages one request at a time takes
 * about seven seconds even with twenty in flight, because it is 500 round
 * trips. Gmail accepts up to 100 sub-requests in a single multipart POST, so
 * the same page becomes five.
 *
 * The format is old and fiddly — multipart/mixed with a raw HTTP request in
 * each part, and a multipart response to parse back apart — which is why this
 * lives on its own with the parsing kept explicit.
 */
import { ReauthRequiredError } from './index.js'
import type { MessageMetadata } from './messages.js'

const BATCH_URL = 'https://gmail.googleapis.com/batch/gmail/v1'

/** Gmail's documented ceiling for sub-requests in one batch. */
export const BATCH_LIMIT = 100

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

function header(headers: RawHeader[] | undefined, name: string): string {
  const match = headers?.find(
    (candidate) => candidate.name.toLowerCase() === name.toLowerCase(),
  )
  return match?.value ?? ''
}

function toMetadata(raw: RawMessage): MessageMetadata {
  return {
    gmailMessageId: raw.id,
    threadId: raw.threadId,
    from: header(raw.payload?.headers, 'From'),
    subject: header(raw.payload?.headers, 'Subject'),
    snippet: raw.snippet ?? '',
    labels: raw.labelIds ?? [],
    receivedAt: new Date(Number(raw.internalDate ?? Date.now())),
  }
}

interface SubResponse {
  status: number
  json: unknown
}

/**
 * Splits a multipart batch response into its individual HTTP responses.
 *
 * Parts split on the boundary the server echoes back in its own Content-Type,
 * not the one that was sent — Google does not reuse it. Each part holds a
 * complete HTTP response, so both the status line and the JSON body are read
 * out: **the status matters**. Google answers a batch with 200 even when
 * individual sub-requests inside it failed, so ignoring per-part status is
 * how a page quietly comes back short.
 */
function parseBatchResponse(contentType: string, body: string): SubResponse[] {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
  const marker = boundary?.[1] ?? boundary?.[2]
  if (!marker) throw new Error('Gmail batch response had no boundary')

  const results: SubResponse[] = []

  for (const part of body.split(`--${marker.trim()}`)) {
    const statusLine = /^HTTP\/[\d.]+ (\d{3})/m.exec(part)
    if (!statusLine) continue

    const status = Number(statusLine[1])

    const start = part.indexOf('{')
    const end = part.lastIndexOf('}')
    if (start === -1 || end <= start) {
      results.push({ status, json: null })
      continue
    }

    try {
      results.push({ status, json: JSON.parse(part.slice(start, end + 1)) })
    } catch {
      results.push({ status, json: null })
    }
  }

  return results
}

/**
 * Metadata for up to `BATCH_LIMIT` messages in one request.
 *
 * `format=metadata` with an explicit header list, exactly as the single-message
 * path does — bodies are never fetched during indexing, and that has to stay
 * true whichever transport is used.
 */
async function fetchMetadataBatch(
  accessToken: string,
  messageIds: readonly string[],
): Promise<{ found: MessageMetadata[]; retryable: string[] }> {
  const boundary = `hive_batch_${Math.random().toString(36).slice(2)}`

  const parts = messageIds
    .map((id, index) => {
      const query =
        'format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date'
      return [
        `--${boundary}`,
        'Content-Type: application/http',
        `Content-ID: <item-${index}>`,
        '',
        `GET /gmail/v1/users/me/messages/${id}?${query}`,
        '',
      ].join('\r\n')
    })
    .join('\r\n')

  const response = await fetch(BATCH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/mixed; boundary=${boundary}`,
    },
    body: `${parts}\r\n--${boundary}--\r\n`,
  })

  if (response.status === 401) throw new ReauthRequiredError()
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Gmail batch failed (${response.status}): ${detail}`)
  }

  const parsed = parseBatchResponse(
    response.headers.get('content-type') ?? '',
    await response.text(),
  )

  const found: MessageMetadata[] = []
  const retryable: string[] = []

  /*
   * Sub-responses come back in request order, so the index maps to the ID
   * that was asked for. That is what makes a retry possible at all — a 429
   * body carries no message ID to identify itself by.
   */
  parsed.forEach((sub, index) => {
    const id = messageIds[index]
    const raw = sub.json as RawMessage | null

    if (sub.status === 200 && typeof raw?.id === 'string') {
      found.push(toMetadata(raw))
      return
    }

    // 429 and 5xx are transient — a hundred metadata reads at once is enough
    // to trip Gmail's per-second quota, and those parts come back throttled
    // while their neighbours succeed.
    if (id && (sub.status === 429 || sub.status >= 500)) retryable.push(id)
  })

  return { found, retryable }
}

/**
 * Metadata for any number of messages, in batches.
 *
 * Order is not guaranteed by the batch response, and callers sort by date
 * anyway, so nothing here tries to preserve it. IDs Gmail refuses are simply
 * absent from the result rather than throwing — a single deleted message
 * should not fail a whole page.
 */
const MAX_ATTEMPTS = 4

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function fetchMessagesMetadata(
  accessToken: string,
  messageIds: readonly string[],
  onProgress?: (done: number, total: number) => void,
): Promise<MessageMetadata[]> {
  const collected: MessageMetadata[] = []

  /*
   * Throttled sub-requests are retried rather than dropped.
   *
   * This is not defensive padding: sending a hundred metadata reads in one
   * batch reliably trips Gmail's per-second quota, and the first version of
   * this silently returned 195 of 264 messages because the throttled parts
   * carried an error body instead of a message and were filtered out. A page
   * that is quietly incomplete is worse than a slow one.
   */
  let pending = [...messageIds]

  for (let attempt = 0; attempt < MAX_ATTEMPTS && pending.length > 0; attempt++) {
    if (attempt > 0) await sleep(400 * 2 ** (attempt - 1))

    const stillPending: string[] = []

    for (let i = 0; i < pending.length; i += BATCH_LIMIT) {
      const slice = pending.slice(i, i + BATCH_LIMIT)
      const { found, retryable } = await fetchMetadataBatch(accessToken, slice)

      collected.push(...found)
      stillPending.push(...retryable)

      onProgress?.(collected.length, messageIds.length)
    }

    pending = stillPending
  }

  if (pending.length > 0) {
    // Said out loud rather than swallowed. The caller still gets what did
    // arrive, but a short page should be visible in the logs.
    console.warn(
      `gmail batch: ${pending.length} of ${messageIds.length} messages still throttled after ${MAX_ATTEMPTS} attempts`,
    )
  }

  return collected
}

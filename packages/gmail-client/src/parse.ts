/**
 * Turns Gmail's MIME tree into something a UI can render.
 *
 * Gmail returns the message as a nested `payload` of parts, and where the
 * readable text lives depends on how the sender's client built it — plain
 * only, HTML only, `multipart/alternative` with both, `multipart/mixed` with
 * attachments wrapped around either. Doing this on the server keeps that mess
 * out of the client and means the shape the UI depends on is stable.
 */

interface RawHeader {
  name: string
  value: string
}

interface RawPart {
  partId?: string
  mimeType?: string
  filename?: string
  headers?: RawHeader[]
  body?: { size?: number; data?: string; attachmentId?: string }
  parts?: RawPart[]
}

export interface RawFullMessage {
  id: string
  threadId: string
  labelIds?: string[]
  snippet?: string
  internalDate?: string
  payload?: RawPart
}

export interface MessageAttachment {
  attachmentId: string
  filename: string
  mimeType: string
  size: number
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
  /** Plain text, if the message carried any. */
  text: string | null
  /** HTML, still untrusted — the client must sanitise before rendering. */
  html: string | null
  attachments: MessageAttachment[]
}

function header(part: RawPart | undefined, name: string): string {
  const match = part?.headers?.find(
    (candidate) => candidate.name.toLowerCase() === name.toLowerCase(),
  )
  return match?.value ?? ''
}

/** Gmail encodes part bodies as base64url. */
function decodeBody(data: string | undefined): string {
  if (!data) return ''
  try {
    return Buffer.from(data, 'base64url').toString('utf8')
  } catch {
    return ''
  }
}

/**
 * Walks the whole tree once, collecting the first text and HTML bodies plus
 * every attachment.
 *
 * "First" rather than "last": `multipart/alternative` lists parts worst-to-
 * best, but nested forwards can add more later, and the outermost one is the
 * message itself rather than something quoted inside it.
 */
function walk(
  part: RawPart | undefined,
  found: { text: string | null; html: string | null; attachments: MessageAttachment[] },
): void {
  if (!part) return

  const mime = part.mimeType ?? ''
  const filename = part.filename ?? ''

  // A part with a filename and an attachmentId is a file, whatever its type —
  // an inline image is still something the reader should know about.
  if (filename && part.body?.attachmentId) {
    found.attachments.push({
      attachmentId: part.body.attachmentId,
      filename,
      mimeType: mime || 'application/octet-stream',
      size: part.body.size ?? 0,
    })
  } else if (mime === 'text/plain' && found.text === null && part.body?.data) {
    found.text = decodeBody(part.body.data)
  } else if (mime === 'text/html' && found.html === null && part.body?.data) {
    found.html = decodeBody(part.body.data)
  }

  for (const child of part.parts ?? []) walk(child, found)
}

export function parseMessage(raw: RawFullMessage): ParsedMessage {
  const found = {
    text: null as string | null,
    html: null as string | null,
    attachments: [] as MessageAttachment[],
  }

  walk(raw.payload, found)

  return {
    id: raw.id,
    threadId: raw.threadId,
    subject: header(raw.payload, 'Subject'),
    from: header(raw.payload, 'From'),
    to: header(raw.payload, 'To'),
    cc: header(raw.payload, 'Cc'),
    // internalDate is epoch millis as a string, and is what Gmail sorts by.
    date: new Date(Number(raw.internalDate ?? Date.now())).toISOString(),
    labels: raw.labelIds ?? [],
    snippet: raw.snippet ?? '',
    text: found.text,
    html: found.html,
    attachments: found.attachments,
  }
}

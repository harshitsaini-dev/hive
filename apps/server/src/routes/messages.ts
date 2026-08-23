import { Router } from 'express'
import { z } from 'zod'
import { listAccountsForOwner, writeAuditEntry } from '@hive/db'
import {
  buildRawMessage,
  getAttachment,
  getSendAsDisplayName,
  mapWithConcurrency,
  parseMessage,
  type RawFullMessage,
  getMessageFull,
  getMessageMetadata,
  listAllMessageIds,
  listMessages,
  permanentlyDeleteMessages,
  ScopeNotGrantedError,
  sendMessage,
  trashMessages,
  untrashMessages,
} from '@hive/gmail-client'
import { asyncRoute, badRequest, HttpError } from '../errors.js'
import { authed, requireAuth } from '../middleware/auth.js'
import { scopeMissing, withGmail } from '../gmail.js'

export const messagesRouter: Router = Router()

/**
 * Ceiling on how many messages one bulk action may touch.
 *
 * Not a Gmail limit — a deliberate blast-radius cap. A mistyped query like
 * `older_than:1d` matching an entire mailbox should hit a wall the user has to
 * acknowledge, rather than quietly processing everything.
 */
const MAX_BULK = 5000

/**
 * A page can be large — the point of the product is working through thousands
 * — but every message costs a separate metadata fetch, so the ceiling is a
 * real one rather than a formality. See PAGE_CONCURRENCY below.
 */
const MAX_PAGE_SIZE = 500

const searchSchema = z.object({
  accountId: z.string().min(1).optional(),
  q: z.string().max(500).optional(),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(100),
  /**
   * Cursor for the next page.
   *
   * Gmail paginates per mailbox, and a merged view spans several, so this is
   * not one opaque token but a set of them — encoded as JSON so the client
   * never has to understand the shape. It hands back whatever it was given.
   */
  pageToken: z.string().max(4000).optional(),
})

/** Decodes the per-account cursor set, tolerating anything malformed. */
function decodeCursors(token: string | undefined): Record<string, string> {
  if (!token) return {}
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(token, 'base64url').toString('utf8'),
    )
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, string>)
      : {}
  } catch {
    // A cursor the client mangled should restart the search, not 500.
    return {}
  }
}

function encodeCursors(cursors: Record<string, string>): string | null {
  const entries = Object.entries(cursors).filter(([, value]) => value)
  if (entries.length === 0) return null
  return Buffer.from(JSON.stringify(Object.fromEntries(entries))).toString(
    'base64url',
  )
}

/**
 * How many message-metadata fetches run at once, per account.
 *
 * Gmail meters roughly 250 quota units a second per user and a metadata fetch
 * costs 5, so about 50 a second is the ceiling before it starts refusing.
 * Twenty in flight keeps latency low without walking into 429s.
 */
const PAGE_CONCURRENCY = 20

const bulkSchema = z.object({
  accountId: z.string().min(1),
  messageIds: z.array(z.string().min(1)).min(1).max(MAX_BULK),
})

const bulkQuerySchema = z.object({
  accountId: z.string().min(1),
  query: z.string().min(1).max(500),
})

/**
 * GET /messages — search one account, or all of them at once.
 *
 * The unified view interleaves accounts by date. Pagination is per-account, so
 * a merged page carries a token per account rather than one opaque cursor.
 */
messagesRouter.get(
  '/',
  requireAuth,
  asyncRoute(async (req, res) => {
    const parsed = searchSchema.safeParse(req.query)
    if (!parsed.success) throw badRequest('Invalid search')

    const { user } = authed(req)
    const { accountId, q, pageSize, pageToken } = parsed.data

    const accounts = await listAccountsForOwner(user.id)
    const targets = accountId
      ? accounts.filter((account) => account.id === accountId)
      : accounts

    if (accountId && targets.length === 0) throw badRequest('Unknown account')

    // Accounts needing reconnection are skipped rather than failing the whole
    // search — one stale account must not hide the others' results.
    const usable = targets.filter((account) => account.status === 'active')

    const cursors = decodeCursors(pageToken)

    /*
     * On a follow-up page, only ask the accounts that still have one. An
     * account that ran out would otherwise restart from the top and repeat
     * its first page on every "load more".
     */
    const stillPaging = pageToken
      ? usable.filter((account) => cursors[account.id])
      : usable

    /*
     * Each account gets the full page size rather than a share of it.
     * Splitting would mean a mailbox with nothing matching wastes its
     * allocation while a busy one is cut short, and the merged list would be
     * shorter than asked for with no explanation.
     */
    const perAccount = await Promise.all(
      stillPaging.map(async (account) => {
        try {
          return await withGmail(user.id, account.id, async (session) => {
            const page = await listMessages(session.accessToken, {
              query: q,
              pageToken: cursors[account.id],
              maxResults: pageSize,
            })

            // Concurrency-limited: a page of 500 fired at once collects 429s
            // from Gmail rather than messages.
            const messages = await mapWithConcurrency(
              page.messages,
              PAGE_CONCURRENCY,
              (ref) => getMessageMetadata(session.accessToken, ref.id),
            )

            return {
              accountId: account.id,
              gmailAddress: account.gmail_address,
              nextPageToken: page.nextPageToken ?? null,
              messages: messages.map((message) => ({
                ...message,
                accountId: account.id,
                gmailAddress: account.gmail_address,
                receivedAt: message.receivedAt.toISOString(),
              })),
              error: null as string | null,
            }
          })
        } catch (error) {
          // Report per-account so the UI can say which one is broken.
          return {
            accountId: account.id,
            gmailAddress: account.gmail_address,
            nextPageToken: null,
            messages: [],
            error: error instanceof Error ? error.message : 'Search failed',
          }
        }
      }),
    )

    const merged = perAccount
      .flatMap((result) => result.messages)
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))

    const nextCursors: Record<string, string> = {}
    for (const result of perAccount) {
      if (result.nextPageToken) nextCursors[result.accountId] = result.nextPageToken
    }

    res.json({
      messages: merged,
      // One opaque string the client hands straight back. Null means the end.
      nextPageToken: encodeCursors(nextCursors),
      accounts: perAccount.map(({ messages: _messages, ...rest }) => rest),
      skipped: targets
        .filter((account) => account.status !== 'active')
        .map((account) => ({
          accountId: account.id,
          gmailAddress: account.gmail_address,
          reason: account.status,
        })),
    })
  }),
)

/**
 * GET /messages/:id — one message, ready to render.
 *
 * Fetched live and never stored: the privacy claim is that bodies are not
 * persisted, and the only way that stays true is by not having a place to put
 * them. Parsed here rather than in the browser so the client depends on a
 * stable shape instead of Gmail's MIME tree.
 */
messagesRouter.get(
  '/:id',
  requireAuth,
  asyncRoute(async (req, res) => {
    const accountId = String(req.query.accountId ?? '')
    const messageId = req.params.id
    if (!accountId || !messageId) throw badRequest('accountId is required')

    const raw = await withGmail(authed(req).user.id, accountId, (session) =>
      getMessageFull(session.accessToken, messageId),
    )

    res.json({ message: parseMessage(raw as RawFullMessage) })
  }),
)

/**
 * GET /messages/:id/attachments/:attachmentId — the bytes of one attachment.
 *
 * Streamed straight through with a download disposition. Nothing is written to
 * disk or to the database on the way past.
 */
messagesRouter.get(
  '/:id/attachments/:attachmentId',
  requireAuth,
  asyncRoute(async (req, res) => {
    const accountId = String(req.query.accountId ?? '')
    const messageId = req.params.id
    const attachmentId = req.params.attachmentId
    if (!accountId || !messageId || !attachmentId) {
      throw badRequest('accountId is required')
    }

    // Client-supplied, so it decides the download name — strip anything that
    // could climb out of a directory or fake a second extension.
    const filename =
      String(req.query.filename ?? 'attachment')
        .replace(/[^\w.\- ]+/g, '_')
        .slice(0, 120) || 'attachment'

    const { data } = await withGmail(
      authed(req).user.id,
      accountId,
      (session) => getAttachment(session.accessToken, messageId, attachmentId),
    )

    const bytes = Buffer.from(data, 'base64url')

    // Always a download, never rendered inline: an HTML or SVG attachment
    // opened in this origin would run script with the session's cookies.
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.send(bytes)
  }),
)

/**
 * POST /messages/resolve-query — how many messages a query actually matches.
 *
 * The UI calls this before a bulk action so the confirmation can state a real
 * number. Guessing from a page count would understate it by orders of
 * magnitude.
 */
messagesRouter.post(
  '/resolve-query',
  requireAuth,
  asyncRoute(async (req, res) => {
    const parsed = bulkQuerySchema.safeParse(req.body)
    if (!parsed.success) throw badRequest('A query and accountId are required')

    const { accountId, query } = parsed.data

    const result = await withGmail(authed(req).user.id, accountId, (session) =>
      listAllMessageIds(session.accessToken, query, MAX_BULK),
    )

    res.json({
      messageIds: result.ids,
      count: result.ids.length,
      // True when the query matched more than the cap — the UI must say so,
      // or the user believes the action covered everything.
      truncated: result.truncated,
      limit: MAX_BULK,
    })
  }),
)

/** POST /messages/trash — reversible. The default for every bulk cleanup. */
messagesRouter.post(
  '/trash',
  requireAuth,
  asyncRoute(async (req, res) => {
    const parsed = bulkSchema.safeParse(req.body)
    if (!parsed.success) {
      throw badRequest(`Provide accountId and 1–${MAX_BULK} messageIds`)
    }

    const { user } = authed(req)
    const { accountId, messageIds } = parsed.data

    const result = await withGmail(user.id, accountId, async (session) => {
      await trashMessages(session.accessToken, messageIds)

      await writeAuditEntry({
        userId: user.id,
        accountId: session.account.id,
        action: 'trash',
        details: { count: messageIds.length },
      })

      return { trashed: messageIds.length }
    })

    res.json(result)
  }),
)

/** POST /messages/restore — pulls messages back out of Trash. */
messagesRouter.post(
  '/restore',
  requireAuth,
  asyncRoute(async (req, res) => {
    const parsed = bulkSchema.safeParse(req.body)
    if (!parsed.success) throw badRequest('Provide accountId and messageIds')

    const { user } = authed(req)
    const { accountId, messageIds } = parsed.data

    const result = await withGmail(user.id, accountId, async (session) => {
      await untrashMessages(session.accessToken, messageIds)

      await writeAuditEntry({
        userId: user.id,
        accountId: session.account.id,
        action: 'restore',
        details: { count: messageIds.length },
      })

      return { restored: messageIds.length }
    })

    res.json(result)
  }),
)

/**
 * POST /messages/delete-forever — irreversible.
 *
 * Three guards, because there is no undo:
 *  1. the connection must actually hold the restricted scope,
 *  2. the caller must send an explicit confirmation flag, so no client can
 *     reach this by reusing a trash-shaped request,
 *  3. the audit row is written *before* the call, so a partial failure still
 *     leaves a record of what was attempted.
 *
 * See ADR 0002.
 */
messagesRouter.post(
  '/delete-forever',
  requireAuth,
  asyncRoute(async (req, res) => {
    const parsed = bulkSchema
      .extend({ confirm: z.literal('permanently delete') })
      .safeParse(req.body)

    if (!parsed.success) {
      throw badRequest(
        'Permanent deletion requires confirm: "permanently delete" and 1 or more messageIds',
      )
    }

    const { user } = authed(req)
    const { accountId, messageIds } = parsed.data

    const result = await withGmail(user.id, accountId, async (session) => {
      if (!session.canDeleteForever) throw scopeMissing()

      await writeAuditEntry({
        userId: user.id,
        accountId: session.account.id,
        action: 'delete_forever',
        details: { count: messageIds.length },
      })

      try {
        await permanentlyDeleteMessages(session.accessToken, messageIds)
      } catch (error) {
        if (error instanceof ScopeNotGrantedError) throw scopeMissing()
        throw error
      }

      return { deleted: messageIds.length }
    })

    res.json(result)
  }),
)

/**
 * Total attachment budget for one message.
 *
 * Gmail refuses anything over 25 MB, and base64 inflates bytes by about a
 * third — so 18 MB of files is roughly the real ceiling. Rejecting here with a
 * clear message beats letting Gmail reject it after the upload.
 */
const MAX_ATTACHMENT_BYTES = 18 * 1024 * 1024

const sendSchema = z.object({
  accountId: z.string().min(1),
  to: z.string().trim().email('Enter a valid recipient address').max(254),
  subject: z.string().trim().max(998).default(''),
  body: z.string().max(100_000).default(''),
  attachments: z
    .array(
      z.object({
        filename: z.string().min(1).max(200),
        mimeType: z.string().max(120).default('application/octet-stream'),
        base64: z.string().max(30_000_000),
      }),
    )
    .max(20)
    .default([]),
})

/**
 * POST /messages/send
 *
 * Gmail enforces its own daily send limits — roughly 500 for consumer
 * accounts, 2,000 for Workspace. Hive does not track that count; it surfaces
 * Google's own rejection instead of guessing, because a wrong local counter
 * would either block legitimate sends or promise capacity that is not there.
 */
messagesRouter.post(
  '/send',
  requireAuth,
  asyncRoute(async (req, res) => {
    const parsed = sendSchema.safeParse(req.body)
    if (!parsed.success) {
      throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid message')
    }

    const { user } = authed(req)
    const { accountId, to, subject, body, attachments } = parsed.data

    // Measured from the decoded size, not the base64 length, so the number in
    // the error is the one the user recognises from their file manager.
    const totalBytes = attachments.reduce(
      (sum, file) => sum + Math.floor((file.base64.length * 3) / 4),
      0,
    )
    if (totalBytes > MAX_ATTACHMENT_BYTES) {
      throw badRequest(
        `Attachments total ${Math.round(totalBytes / 1024 / 1024)} MB. Gmail allows about ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB.`,
      )
    }

    const result = await withGmail(user.id, accountId, async (session) => {
      /*
       * The display name Gmail itself uses. Without it, mail sent through Hive
       * shows a bare address while the same person's mail sent from Gmail
       * shows their name — the two look like different senders.
       */
      const displayName = await getSendAsDisplayName(
        session.accessToken,
        session.account.gmail_address,
      )

      const raw = buildRawMessage({
        // The From address is the connected mailbox, never client-supplied —
        // Gmail would reject a mismatch anyway, and accepting one invites
        // spoofing attempts against the endpoint.
        from: displayName
          ? `${displayName} <${session.account.gmail_address}>`
          : session.account.gmail_address,
        to,
        subject,
        body,
        attachments,
      })

      let sent
      try {
        sent = await sendMessage(session.accessToken, raw)
      } catch (error) {
        const message = error instanceof Error ? error.message : ''
        // Google reports the daily cap as a 429. Say so plainly rather than
        // letting it surface as a generic failure.
        if (message.includes('429') || /rate|quota|limit/i.test(message)) {
          throw new HttpError(
            429,
            'send_quota_reached',
            'Gmail has hit its daily send limit for this account. Try again tomorrow.',
          )
        }
        throw error
      }

      await writeAuditEntry({
        userId: user.id,
        accountId: session.account.id,
        action: 'send',
        // Recipient and subject only. Never the body — see the privacy rules.
        details: { to, subject, attachments: attachments.length },
      })

      return { id: sent.id, threadId: sent.threadId }
    })

    res.status(201).json(result)
  }),
)

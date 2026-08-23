import { Router } from 'express'
import { z } from 'zod'
import { listAccountsForOwner, writeAuditEntry } from '@hive/db'
import {
  buildRawMessage,
  fetchMessagesMetadata,
  getAttachment,
  getSendAsDisplayName,
  parseMessage,
  type RawFullMessage,
  getMessageFull,
  listAllMessageIds,
  listMessages,
  permanentlyDeleteMessages,
  RateLimitedError,
  ScopeNotGrantedError,
  sendMessage,
  trashMessages,
  untrashMessages,
} from '@hive/gmail-client'
import { asyncRoute, badRequest, HttpError, notFound } from '../errors.js'
import {
  advanceJob,
  createJob,
  finishJob,
  getJob,
  setJobResult,
  setJobTotal,
} from '../jobs.js'
import { authed, requireAuth } from '../middleware/auth.js'
import { scopeMissing, withGmail } from '../gmail.js'

export const messagesRouter: Router = Router()

/**
 * The image type these bytes actually are, or null.
 *
 * Magic numbers, not the sender's `Content-Type` and not a query parameter:
 * both are written by someone else, and the decision being made here is
 * whether to render something in this origin. Raster formats only — an SVG is
 * a document that can carry script, so it never qualifies however it is
 * labelled.
 */
function sniffImageType(bytes: Buffer): string | null {
  if (bytes.length < 12) return null

  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    return 'image/png'
  }
  if (bytes.subarray(0, 6).toString('latin1').match(/^GIF8[79]a$/)) {
    return 'image/gif'
  }
  if (
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp'
  }

  return null
}

/**
 * A sentence, not Google's error envelope.
 *
 * A rate-limited search used to put six hundred characters of nested JSON on
 * screen — `PERMISSION_DENIED`, quota metric names, a project number — which
 * reads as "this app is broken and possibly leaking its internals" when the
 * actual meaning is "you asked for too much in one minute".
 */
function describeGmailFailure(error: unknown): string {
  if (error instanceof RateLimitedError) return error.message

  const message = error instanceof Error ? error.message : ''
  if (/rateLimitExceeded|Quota exceeded/i.test(message)) {
    return 'Gmail is rate limiting this account. Wait a minute and try again.'
  }

  // Anything else: say it failed without repeating Google's payload back.
  return 'Gmail could not complete this search.'
}

/**
 * Ceiling on how many messages one bulk action may touch.
 *
 * Not a Gmail limit — a deliberate blast-radius cap. A mistyped query like
 * `older_than:1d` matching an entire mailbox should hit a wall the user has to
 * acknowledge, rather than quietly processing everything.
 *
 * Ten thousand rather than five: real mailboxes are that size, and stopping
 * halfway just made people run the same cleanup twice. The wall still exists,
 * the UI still says when a search exceeded it, and permanent deletion still
 * needs a typed confirmation showing the exact count.
 */
const MAX_BULK = 10_000

/**
 * A page can be large — the point of the product is working through thousands
 * — but every message costs a separate metadata fetch, so the ceiling is a
 * real one rather than a formality: each batch carries a hundred, so a full
 * page is five requests to Gmail.
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

const bulkSchema = z.object({
  accountId: z.string().min(1),
  messageIds: z.array(z.string().min(1)).min(1).max(MAX_BULK),
  /**
   * Return a job id immediately and keep working, so the client can show
   * progress. Small selections stay synchronous, where a job would be pure
   * overhead.
   */
  background: z.boolean().default(false),
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

            // One batch request per hundred messages rather than one per
            // message: a page of 500 is five round trips instead of 500.
            const messages = await fetchMessagesMetadata(
              session.accessToken,
              page.messages.map((ref) => ref.id),
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
            error: describeGmailFailure(error),
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

    /*
     * Inline display, for images only, and only when the bytes themselves say
     * so.
     *
     * Everything else is still a download, because an HTML or SVG attachment
     * rendered in this origin would run script with the session's cookies.
     * SVG is an image and is deliberately not on the list for exactly that
     * reason — it is a document that can carry script.
     *
     * The type comes from sniffing the first few bytes rather than from
     * anything the client or the sender claimed. A caller asking for a
     * `image/png` that is really HTML gets a download, which is the whole
     * point of deciding here instead of trusting a parameter.
     */
    const sniffed = sniffImageType(bytes)
    if (req.query.inline === '1' && sniffed) {
      res.setHeader('Content-Type', sniffed)
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`)
      res.setHeader('X-Content-Type-Options', 'nosniff')
      // Belt and braces: even if the sniff were fooled, nothing may load or
      // run from a document served here.
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")
      res.send(bytes)
      return
    }

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

/**
 * Ceiling on how many messages one analysis run reads headers for.
 *
 * The counts above it are exact and nearly free — message ids come back 500
 * at a time, so even a hundred thousand of them is a couple of hundred cheap
 * calls. Working out *who sent them* is a different price entirely: that
 * needs the `From` header of every single message, which is a metadata read
 * each, and Gmail allows about three thousand of those a minute.
 *
 * So a hundred thousand messages is roughly half an hour of solid fetching
 * for the sender breakdown alone. Rather than pretend otherwise, the run
 * reads the newest slice, reports exactly how deep it got, and lets the
 * caller ask for more. The totals it sits beside are still for everything.
 */
const MAX_SCAN = 250_000

/**
 * Ceiling on the id listing behind the exact counts.
 *
 * Deliberately far above `MAX_BULK`, which exists to limit the blast radius
 * of an *action*. Nothing is destroyed by counting, and reusing the action
 * cap here was a real bug: a hundred-thousand-message mailbox reported a
 * total of ten thousand, which is a wrong number presented as a fact.
 */
const MAX_COUNT = 250_000

/** Newest first, which is the order Gmail returns ids in. */
const analyticsSchema = z.object({
  accountId: z.string().min(1).optional(),
  query: z.string().max(500),
  scanLimit: z.number().int().min(100).max(MAX_SCAN),
})

/** `"Kapil Gupta <kapil@example.com>"` -> both halves, separately useful. */
function splitFrom(from: string): { name: string; address: string } {
  const withAngle = /^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/.exec(from)
  if (withAngle) {
    return {
      name: (withAngle[1] ?? '').trim(),
      address: (withAngle[2] ?? '').trim().toLowerCase(),
    }
  }

  const bare = from.trim().replace(/[<>]/g, '').toLowerCase()
  return { name: '', address: bare }
}

interface SenderTally {
  address: string
  name: string
  count: number
  withAttachment: number
}

/**
 * POST /messages/analytics — what is actually in the mailbox, and who put it
 * there.
 *
 * A job rather than a plain response because the sender breakdown reads a
 * header per message and a large mailbox takes minutes. The two counts that
 * matter most — how many match, and how many of those carry a file — are
 * resolved from id lists and are exact regardless of how deep the scan got.
 */
messagesRouter.post(
  '/analytics',
  requireAuth,
  asyncRoute(async (req, res) => {
    const parsed = analyticsSchema.safeParse(req.body)
    if (!parsed.success) throw badRequest('A query and scanLimit are required')

    const { accountId, query, scanLimit } = parsed.data
    const user = authed(req).user

    const accounts = (await listAccountsForOwner(user.id)).filter(
      (account) => !accountId || account.id === accountId,
    )
    if (accounts.length === 0) throw badRequest('No matching account')

    // Corrected below, once the query has been resolved and the real size of
    // the work is known.
    const job = createJob(user.id, 'analyze', 0)
    res.json({ jobId: job.id })

    void (async () => {
      try {
        let total = 0
        let withAttachment = 0
        let scanned = 0
        let truncated = false
        const senders = new Map<string, SenderTally>()

        for (const account of accounts) {
          await withGmail(user.id, account.id, async (session) => {
            // Ids only: 500 per call, so this stays cheap at any size.
            const all = await listAllMessageIds(
              session.accessToken,
              query,
              MAX_COUNT,
            )
            const attached = await listAllMessageIds(
              session.accessToken,
              `${query} has:attachment`,
              MAX_COUNT,
            )

            total += all.ids.length
            withAttachment += attached.ids.length
            if (all.truncated) truncated = true

            const attachedSet = new Set(attached.ids)
            const slice = all.ids.slice(0, scanLimit)
            if (slice.length < all.ids.length) truncated = true

            const before = scanned
            setJobTotal(job.id, before + slice.length)
            const metadata = await fetchMessagesMetadata(
              session.accessToken,
              slice,
              (done) => advanceJob(job.id, before + done),
            )

            for (const message of metadata) {
              const { name, address } = splitFrom(message.from)
              if (!address) continue

              const tally = senders.get(address) ?? {
                address,
                // The first non-empty display name wins; senders vary it.
                name: '',
                count: 0,
                withAttachment: 0,
              }
              if (!tally.name && name) tally.name = name
              tally.count += 1
              if (attachedSet.has(message.gmailMessageId)) {
                tally.withAttachment += 1
              }
              senders.set(address, tally)
            }

            scanned += slice.length
          })
        }

        setJobResult(job.id, {
          total,
          withAttachment,
          withoutAttachment: Math.max(0, total - withAttachment),
          scanned,
          truncated,
          // Ranked, and capped: a thousand rows of one message each is not a
          // finding, and the client would render every one of them.
          senders: [...senders.values()]
            .sort((a, b) => b.count - a.count)
            .slice(0, 200),
        })
        finishJob(job.id)
      } catch (error) {
        finishJob(job.id, describeGmailFailure(error))
      }
    })()
  }),
)

/**
 * Runs a bulk action, optionally in the background with a progress job.
 *
 * Synchronous by default: for a handful of messages the round trip is shorter
 * than the poll interval would be, and a job would be pure overhead. With
 * `background: true` the response returns a job id straight away and the work
 * continues — which is the only way a progress bar can exist, since the
 * response of a synchronous call arrives once, at the end.
 */
async function runBulkAction(options: {
  ownerId: string
  accountId: string
  messageIds: string[]
  action: 'trash' | 'restore' | 'delete_forever'
  background: boolean
  work: (
    accessToken: string,
    onProgress: (processed: number) => void,
  ) => Promise<void>
  audit: (accountId: string) => Promise<unknown>
}): Promise<{ jobId: string } | { processed: number }> {
  const { ownerId, accountId, messageIds, action, background, work, audit } =
    options

  if (!background) {
    await withGmail(ownerId, accountId, async (session) => {
      await audit(session.account.id)
      await work(session.accessToken, () => {})
    })
    return { processed: messageIds.length }
  }

  const job = createJob(ownerId, action, messageIds.length)

  /*
   * Deliberately not awaited — the response goes out now and the client polls.
   * Every path inside is wrapped, because an unhandled rejection here would
   * take the process down rather than fail one job.
   */
  void (async () => {
    try {
      await withGmail(ownerId, accountId, async (session) => {
        await audit(session.account.id)
        await work(session.accessToken, (processed) =>
          advanceJob(job.id, processed),
        )
      })
      finishJob(job.id)
    } catch (error) {
      console.error(`bulk ${action} failed:`, error)
      finishJob(
        job.id,
        error instanceof HttpError
          ? error.message
          : 'That did not finish. Some messages may already have been processed.',
      )
    }
  })()

  return { jobId: job.id }
}

/**
 * GET /messages/jobs/:id — progress for a background bulk action.
 *
 * Polled by the client. Ownership is enforced inside getJob, so a job id
 * cannot be used to watch someone else's mailbox activity.
 */
messagesRouter.get(
  '/jobs/:id',
  requireAuth,
  asyncRoute(async (req, res) => {
    const id = req.params.id
    if (!id) throw badRequest('Missing job id')

    const job = getJob(authed(req).user.id, id)
    if (!job) throw notFound('No such job')

    res.json({
      id: job.id,
      action: job.action,
      total: job.total,
      processed: job.processed,
      status: job.status,
      error: job.error,
      result: job.result,
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
    const { accountId, messageIds, background } = parsed.data

    const result = await runBulkAction({
      ownerId: user.id,
      accountId,
      messageIds,
      action: 'trash',
      background,
      work: (accessToken, onProgress) =>
        trashMessages(accessToken, messageIds, onProgress),
      audit: (id) =>
        writeAuditEntry({
          userId: user.id,
          accountId: id,
          action: 'trash',
          details: { count: messageIds.length },
        }),
    })

    res.json('jobId' in result ? result : { trashed: result.processed })
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
    const { accountId, messageIds, background } = parsed.data

    const result = await runBulkAction({
      ownerId: user.id,
      accountId,
      messageIds,
      action: 'restore',
      background,
      work: (accessToken, onProgress) =>
        untrashMessages(accessToken, messageIds, onProgress),
      audit: (id) =>
        writeAuditEntry({
          userId: user.id,
          accountId: id,
          action: 'restore',
          details: { count: messageIds.length },
        }),
    })

    res.json('jobId' in result ? result : { restored: result.processed })
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
    const { accountId, messageIds, background } = parsed.data

    /*
     * The scope is checked before anything is started, not inside the
     * background worker. A permanent delete that fails halfway is the worst
     * possible outcome here, and refusing up front is the one guard that
     * cannot be missed by a client polling a job it never sees fail.
     */
    await withGmail(user.id, accountId, async (session) => {
      if (!session.canDeleteForever) throw scopeMissing()
    })

    const result = await runBulkAction({
      ownerId: user.id,
      accountId,
      messageIds,
      action: 'delete_forever',
      background,
      // Written before the Gmail call, so a partial failure still leaves a
      // record of what was attempted. See ADR 0002.
      audit: (id) =>
        writeAuditEntry({
          userId: user.id,
          accountId: id,
          action: 'delete_forever',
          details: { count: messageIds.length },
        }),
      work: async (accessToken, onProgress) => {
        try {
          await permanentlyDeleteMessages(accessToken, messageIds, onProgress)
        } catch (error) {
          if (error instanceof ScopeNotGrantedError) throw scopeMissing()
          throw error
        }
      },
    })

    res.json('jobId' in result ? result : { deleted: result.processed })
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

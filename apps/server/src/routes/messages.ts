import { Router } from 'express'
import { z } from 'zod'
import {
  countIndexMatches,
  deleteIndexedMessages,
  findAnalysisRun,
  findSentDisplayName,
  getIndexedByIds,
  moveIndexedLabels,
  listAccountsForOwner,
  searchIndex,
  writeAuditEntry,
  type AccountRow,
} from '@hive/db'
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
import { MAX_SCAN, runAnalysis } from '../analysis.js'
import { freshenIndex } from '../sync.js'
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
 * The analysis job each user currently has in flight, if any.
 *
 * Held so a browser that was closed mid-run can pick the same job back up
 * rather than starting a second one — the work carries on server-side
 * regardless, and starting again would spend the quota twice for one answer.
 *
 * In memory, with the same caveat as the job store itself: fine on a single
 * instance, and something to move into the database if the API is ever
 * scaled out.
 */
const activeAnalysis = new Map<string, string>()

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
 *
 * **It must not blame Gmail for our own faults.** The first version returned
 * "Gmail could not complete this search" for *anything* that went wrong,
 * including a missing database table after a deploy — which sent a real
 * investigation off towards the Gmail API for a problem that was entirely on
 * this side. Whatever the message says, the original is logged.
 */
function describeGmailFailure(error: unknown): string {
  if (error instanceof RateLimitedError) return error.message

  const message = error instanceof Error ? error.message : String(error)
  console.error('mailbox operation failed:', error)

  if (/rateLimitExceeded|Quota exceeded/i.test(message)) {
    return 'Gmail is rate limiting this account. Wait a minute and try again.'
  }
  if (/no such table|SQLITE_|LibsqlError|database/i.test(message)) {
    return 'Hive could not reach its own database. This is a fault on our side, not with your mailbox.'
  }
  if (/Gmail |googleapis/i.test(message)) {
    return 'Gmail could not complete this request.'
  }

  return 'Something went wrong on our side completing that.'
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

/**
 * The structural filters behind `q`, when the client has them.
 *
 * Sent alongside the Gmail query rather than instead of it, so the server can
 * answer from the local index when it is able to and fall back to Gmail
 * without the client knowing or caring which happened.
 *
 * **Free text is deliberately absent.** Gmail searches message bodies; the
 * index holds sender, subject and a short snippet, because storing bodies is
 * exactly what the privacy policy forbids. A text search that quietly stopped
 * matching words inside messages would be a worse product wearing a faster
 * one's clothes — so any query with text in it goes to Gmail, every time.
 */
const structuredSchema = z.object({
  folder: z.enum(['inbox', 'sent', 'drafts', 'spam', 'trash', 'all']),
  from: z.string().max(200).optional(),
  after: z.string().max(20).optional(),
  before: z.string().max(20).optional(),
  olderThanDays: z.coerce.number().int().min(1).max(3650).optional(),
  category: z.string().max(40).optional(),
  hasAttachment: z.coerce.boolean().optional(),
  unreadOnly: z.coerce.boolean().optional(),
})

const searchSchema = z.object({
  accountId: z.string().min(1).optional(),
  q: z.string().max(500).optional(),
  /** JSON, because this arrives on a GET. Absent means "use Gmail". */
  structured: z.string().max(1000).optional(),
  /** Zero-based, for index-served pages. Gmail paging still uses a cursor. */
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
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
 * Turns a list of Gmail ids into displayable rows, as cheaply as possible.
 *
 * **This is what makes a body search fast without storing bodies.** A text
 * query has to go to Gmail: the index holds sender, subject and a snippet,
 * not message content, and storing content is precisely what the privacy
 * policy forbids. But Gmail answers a search with *ids* — the cheap half, 500
 * to a call. Turning those ids into rows is the expensive half, one metadata
 * request each, and that half the index can do for free.
 *
 * So a search of a fully indexed mailbox costs one Gmail call regardless of
 * how many messages it matches, and the words are still matched inside the
 * message bodies by Google. Anything the index has not seen yet — mail that
 * arrived seconds ago, or a mailbox still backfilling — is fetched normally,
 * and the order Gmail returned is preserved either way.
 */
async function hydrate(
  account: AccountRow,
  accessToken: string,
  ids: string[],
) {
  if (ids.length === 0) return []

  const cached = await getIndexedByIds(account.id, ids)
  const byId = new Map(cached.map((row) => [row.gmail_message_id, row]))
  const missing = ids.filter((id) => !byId.has(id))

  if (missing.length > 0) {
    // One batch request per hundred rather than one per message.
    for (const message of await fetchMessagesMetadata(accessToken, missing)) {
      byId.set(message.gmailMessageId, {
        gmail_message_id: message.gmailMessageId,
        thread_id: message.threadId,
        from_addr: message.from,
        subject: message.subject,
        snippet: message.snippet,
        labels_json: JSON.stringify(message.labels),
        received_at: message.receivedAt.toISOString(),
      })
    }
  }

  // Gmail's order, not the database's — relevance and recency are its call.
  return ids.flatMap((id) => {
    const row = byId.get(id)
    if (!row) return []

    return [
      {
        gmailMessageId: row.gmail_message_id,
        threadId: row.thread_id,
        accountId: account.id,
        gmailAddress: account.gmail_address,
        from: row.from_addr,
        subject: row.subject,
        snippet: row.snippet,
        labels: safeParse<string[]>(row.labels_json, []),
        receivedAt: row.received_at,
      },
    ]
  })
}

/** Parses the structured filters, treating anything malformed as absent. */
function parseStructured(raw: string | undefined): IndexQueryShape | null {
  if (!raw) return null

  try {
    const parsed = structuredSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

type IndexQueryShape = z.infer<typeof structuredSchema>

/**
 * Answers a search from the local index, or returns null to fall back.
 *
 * Null on any doubt at all — an account not yet backfilled, indexing paused,
 * a catch-up that failed. Falling back to Gmail costs a few seconds; serving
 * a page that is quietly missing the last hour of mail costs trust, and this
 * project has already learned that lesson twice.
 */
async function searchFromIndex(
  ownerId: string,
  accounts: AccountRow[],
  wanted: IndexQueryShape,
  page: { limit: number; offset: number },
) {
  const fresh = await Promise.all(
    accounts.map((account) => freshenIndex(ownerId, account)),
  )
  if (fresh.some((ok) => !ok)) return null

  const perAccount = await Promise.all(
    accounts.map(async (account) => {
      const query = { ...wanted, accountId: account.id }

      /*
       * Each account is asked for a whole page and the results are merged and
       * re-cut. Wasteful in rows and correct in ordering: asking each for a
       * share would drop older messages from a busy mailbox in favour of
       * newer ones from a quiet one, which is not what "newest first across
       * everything" means.
       */
      const [rows, total] = await Promise.all([
        searchIndex(query, { limit: page.limit + page.offset, offset: 0 }),
        countIndexMatches(query),
      ])

      return {
        accountId: account.id,
        gmailAddress: account.gmail_address,
        total,
        rows,
      }
    }),
  )

  const merged = perAccount
    .flatMap((entry) =>
      entry.rows.map((row) => ({
        gmailMessageId: row.gmail_message_id,
        threadId: row.thread_id,
        accountId: entry.accountId,
        gmailAddress: entry.gmailAddress,
        from: row.from_addr,
        subject: row.subject,
        snippet: row.snippet,
        labels: safeParse<string[]>(row.labels_json, []),
        receivedAt: row.received_at,
      })),
    )
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))

  const total = perAccount.reduce((sum, entry) => sum + entry.total, 0)
  const slice = merged.slice(page.offset, page.offset + page.limit)

  return {
    source: 'index' as const,
    /*
     * The real total, which the Gmail path cannot cheaply produce. It is the
     * number a page is a slice *of* — showing "500 loaded" as though it were
     * the answer is the bug this replaces.
     */
    total,
    messages: slice,
    nextPageToken: null,
    /** Present so the client can page without a cursor. */
    nextOffset: page.offset + slice.length < total
      ? page.offset + slice.length
      : null,
    accounts: perAccount.map((entry) => ({
      accountId: entry.accountId,
      gmailAddress: entry.gmailAddress,
      error: null as string | null,
    })),
    skipped: [] as { accountId: string; gmailAddress: string; reason: string }[],
  }
}

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
    const { accountId, q, structured, offset, pageSize, pageToken } = parsed.data

    const accounts = await listAccountsForOwner(user.id)
    const targets = accountId
      ? accounts.filter((account) => account.id === accountId)
      : accounts

    if (accountId && targets.length === 0) throw badRequest('Unknown account')

    // Accounts needing reconnection are skipped rather than failing the whole
    // search — one stale account must not hide the others' results.
    const usable = targets.filter((account) => account.status === 'active')

    /*
     * The local index first, when it can answer this exactly.
     *
     * A page of 500 from Gmail is 500 metadata reads; from here it is one
     * query. The bar for using it is that the answer must be identical, which
     * is why free text disqualifies: the index has no message bodies to
     * search. `freshenIndex` costs one history call and closes the gap
     * between the hourly sweep and now.
     */
    const wanted = parseStructured(structured)
    if (wanted && usable.length > 0) {
      const served = await searchFromIndex(user.id, usable, wanted, {
        limit: pageSize,
        offset,
      })
      if (served) {
        res.json(served)
        return
      }
    }

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

            const ids = page.messages.map((ref) => ref.id)
            const messages = await hydrate(account, session.accessToken, ids)

            return {
              accountId: account.id,
              gmailAddress: account.gmail_address,
              nextPageToken: page.nextPageToken ?? null,
              messages,
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
      source: 'gmail' as const,
      total: null,
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

/** Analysis lives in its own module; two callers need it. See analysis.ts. */
const analyticsSchema = z.object({
  accountId: z.string().min(1).optional(),
  query: z.string().max(500),
  scanLimit: z.number().int().min(100).max(MAX_SCAN),
  /**
   * The control values behind the query, stored verbatim so the panel can put
   * itself back the way it was on another device. Opaque to the server.
   */
  filters: z.record(z.string(), z.string()).default({}),
})

/**
 * POST /messages/analytics — what is actually in the mailbox, and who put it
 * there.
 *
 * A job rather than a plain response because the sender breakdown reads a
 * header per message and a large mailbox takes minutes. The job outlives the
 * request on purpose: closing the tab mid-run leaves it finishing in the
 * background, and the result is waiting on the next visit.
 */
messagesRouter.post(
  '/analytics',
  requireAuth,
  asyncRoute(async (req, res) => {
    const parsed = analyticsSchema.safeParse(req.body)
    if (!parsed.success) throw badRequest('A query and scanLimit are required')

    const { accountId, query, scanLimit, filters } = parsed.data
    const user = authed(req).user

    // One at a time per user. Two concurrent scans would race each other for
    // the same per-minute quota and both would crawl.
    const existing = activeAnalysis.get(user.id)
    if (existing && getJob(user.id, existing)?.status === 'running') {
      res.json({ jobId: existing })
      return
    }

    const job = createJob(user.id, 'analyze', 0)
    activeAnalysis.set(user.id, job.id)
    res.json({ jobId: job.id })

    void (async () => {
      try {
        const result = await runAnalysis({
          userId: user.id,
          accountId: accountId ?? null,
          query,
          scanLimit,
          filters,
          onProgress: (done, total) => {
            setJobTotal(job.id, total)
            advanceJob(job.id, done)
          },
        })

        setJobResult(job.id, result)
        finishJob(job.id)
      } catch (error) {
        finishJob(job.id, describeGmailFailure(error))
      } finally {
        if (activeAnalysis.get(user.id) === job.id) {
          activeAnalysis.delete(user.id)
        }
      }
    })()
  }),
)

/**
 * GET /messages/analytics/last — the most recent analysis this user ran.
 *
 * What makes the result worth storing is what makes it worth restoring: it
 * cost minutes and a slice of a per-minute quota to produce, and re-running
 * it on every page load would spend both again for an answer that has barely
 * changed.
 */
messagesRouter.get(
  '/analytics/last',
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = authed(req).user.id

    // A run still going is more useful than the one before it: the panel can
    // reattach to it instead of showing a stale result and starting another.
    const activeId = activeAnalysis.get(userId)
    const active =
      activeId && getJob(userId, activeId)?.status === 'running' ? activeId : null

    const row = await findAnalysisRun(userId)
    if (!row) {
      res.json({ run: null, activeJobId: active })
      return
    }

    res.json({
      activeJobId: active,
      run: {
        accountId: row.account_id,
        query: row.query,
        // Written by this server, but parsed defensively all the same: a row
        // from an older shape should read as "nothing saved", not a 500.
        filters: safeParse(row.filters_json, {}),
        result: safeParse(row.result_json, null),
        finishedAt: row.finished_at,
      },
    })
  }),
)

function safeParse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T
  } catch {
    return fallback
  }
}

/**
 * Keeps the index honest about what Hive itself just did.
 *
 * Without this, trashing five hundred messages and letting the list refresh
 * showed all five hundred still sitting in the inbox — the action succeeded
 * at Gmail, and the index, which the list now reads from, had not heard about
 * it. Waiting for the next history pass is not an option: the refresh happens
 * immediately, and being wrong for an hour about mail the user just moved is
 * indistinguishable from the action having failed.
 *
 * A local correction rather than a re-read, because the outcome is already
 * known — Gmail confirmed it. The next history pass will overwrite these rows
 * with Gmail's own version anyway, so a divergence here is temporary by
 * construction.
 */
async function applyToIndex(
  accountId: string,
  messageIds: string[],
  action: 'trash' | 'restore' | 'delete_forever',
): Promise<void> {
  try {
    if (action === 'delete_forever') {
      await deleteIndexedMessages(accountId, messageIds)
      return
    }

    await moveIndexedLabels(
      accountId,
      messageIds,
      action === 'trash'
        ? { add: 'TRASH', remove: ['INBOX', 'UNREAD'] }
        : { add: 'INBOX', remove: ['TRASH'] },
    )
  } catch (error) {
    /*
     * The mail has already moved; this is bookkeeping catching up. Failing the
     * whole action over it would report a success as a failure, which is the
     * more dangerous of the two wrong answers.
     */
    console.warn(`could not update the index after ${action}:`, error)
  }
}

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
    await applyToIndex(accountId, messageIds, action)
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
      await applyToIndex(accountId, messageIds, action)
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
       * The name this mail is sent under.
       *
       * Three sources, in descending order of authority: what Google says
       * this person is called, what Gmail has on the matching `sendAs` alias,
       * and — for a mailbox connected before the profile scope existed — the
       * name it has been sending under all along, read off the `From` header
       * of its own indexed mail.
       *
       * Without any of them, Gmail falls back to the local part of the
       * address and recipients see `harshitsaini.dev` where a person should
       * be. Nothing here asks the user to set anything up.
       */
      const displayName =
        session.account.sender_name ||
        (await getSendAsDisplayName(
          session.accessToken,
          session.account.gmail_address,
        )) ||
        /*
         * Last resort, and the one that needs nothing set up: the name this
         * mailbox has been sending under all along, read off the `From`
         * header of its own indexed mail. If Gmail's settings call gives
         * nothing — and on these accounts it does — the answer is still
         * sitting in every message the user has ever sent.
         */
        (await findSentDisplayName(
          session.account.id,
          session.account.gmail_address,
        ))

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

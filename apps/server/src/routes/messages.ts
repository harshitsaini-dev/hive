import { Router } from 'express'
import { z } from 'zod'
import { listAccountsForOwner, writeAuditEntry } from '@hive/db'
import {
  getMessageFull,
  getMessageMetadata,
  listAllMessageIds,
  listMessages,
  permanentlyDeleteMessages,
  ScopeNotGrantedError,
  trashMessages,
  untrashMessages,
} from '@hive/gmail-client'
import { asyncRoute, badRequest } from '../errors.js'
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

const searchSchema = z.object({
  accountId: z.string().min(1).optional(),
  q: z.string().max(500).optional(),
  pageToken: z.string().max(500).optional(),
})

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
    const { accountId, q, pageToken } = parsed.data

    const accounts = await listAccountsForOwner(user.id)
    const targets = accountId
      ? accounts.filter((account) => account.id === accountId)
      : accounts

    if (accountId && targets.length === 0) throw badRequest('Unknown account')

    // Accounts needing reconnection are skipped rather than failing the whole
    // search — one stale account must not hide the others' results.
    const usable = targets.filter((account) => account.status === 'active')

    const perAccount = await Promise.all(
      usable.map(async (account) => {
        try {
          return await withGmail(user.id, account.id, async (session) => {
            const page = await listMessages(session.accessToken, {
              query: q,
              pageToken,
              maxResults: 25,
            })

            const messages = await Promise.all(
              page.messages.map((ref) =>
                getMessageMetadata(session.accessToken, ref.id),
              ),
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

    res.json({
      messages: merged,
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

/** GET /messages/:id — the full message. Fetched live, never stored. */
messagesRouter.get(
  '/:id',
  requireAuth,
  asyncRoute(async (req, res) => {
    const accountId = String(req.query.accountId ?? '')
    const messageId = req.params.id
    if (!accountId || !messageId) throw badRequest('accountId is required')

    const message = await withGmail(authed(req).user.id, accountId, (session) =>
      getMessageFull(session.accessToken, messageId),
    )

    res.json({ message })
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

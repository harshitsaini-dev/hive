import { Router } from 'express'
import { z } from 'zod'
import {
  createRule,
  deleteRule,
  findAccountForOwner,
  findRuleForOwner,
  listRulesForOwner,
  setRuleEnabled,
} from '@hive/db'
import { asyncRoute, badRequest, notFound } from '../errors.js'
import { authed, requireAuth } from '../middleware/auth.js'
import { runRule } from '../rules-runner.js'

export const rulesRouter: Router = Router()

const createSchema = z.object({
  accountId: z.string().min(1),
  query: z
    .string()
    .trim()
    .min(1, 'A search query is required')
    .max(500)
    // A rule with no filter would trash an entire mailbox on a schedule.
    .refine((value) => value !== '*' && value.length > 2, {
      message: 'That query is too broad to run on a schedule',
    }),
  schedule: z.enum(['manual', 'daily', 'weekly']),
})

/** GET /rules — the caller's rules, across all their accounts. */
rulesRouter.get(
  '/',
  requireAuth,
  asyncRoute(async (req, res) => {
    const rows = await listRulesForOwner(authed(req).user.id)

    res.json({
      rules: rows.map((row) => ({
        id: row.id,
        accountId: row.account_id,
        query: row.query,
        action: row.action,
        schedule: row.schedule,
        enabled: row.enabled === 1,
        lastRunAt: row.last_run_at,
      })),
    })
  }),
)

/**
 * POST /rules
 *
 * `action` is not accepted from the client. Every rule trashes; there is no
 * request shape that can create a scheduled permanent deletion, which is the
 * point (see ADR 0002 and CLAUDE.md).
 */
rulesRouter.post(
  '/',
  requireAuth,
  asyncRoute(async (req, res) => {
    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) {
      throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid rule')
    }

    const { user } = authed(req)
    const { accountId, query, schedule } = parsed.data

    const account = await findAccountForOwner(user.id, accountId)
    if (!account) throw notFound('No such connected account')

    const rule = await createRule({ accountId, query, schedule })

    res.status(201).json({
      rule: {
        id: rule.id,
        accountId: rule.account_id,
        query: rule.query,
        action: rule.action,
        schedule: rule.schedule,
        enabled: rule.enabled === 1,
        lastRunAt: rule.last_run_at,
      },
    })
  }),
)

/** POST /rules/:id/run — run it now. Trashes; still reversible. */
rulesRouter.post(
  '/:id/run',
  requireAuth,
  asyncRoute(async (req, res) => {
    const { user } = authed(req)
    const ruleId = req.params.id
    if (!ruleId) throw badRequest('Missing rule id')

    const rule = await findRuleForOwner(user.id, ruleId)
    if (!rule) throw notFound('No such rule')

    const result = await runRule(user.id, rule)

    res.json(result)
  }),
)

/** PATCH /rules/:id — enable or disable. */
rulesRouter.patch(
  '/:id',
  requireAuth,
  asyncRoute(async (req, res) => {
    const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body)
    if (!parsed.success) throw badRequest('Provide enabled: true or false')

    const ruleId = req.params.id
    if (!ruleId) throw badRequest('Missing rule id')

    const updated = await setRuleEnabled(
      authed(req).user.id,
      ruleId,
      parsed.data.enabled,
    )
    if (!updated) throw notFound('No such rule')

    res.status(204).end()
  }),
)

rulesRouter.delete(
  '/:id',
  requireAuth,
  asyncRoute(async (req, res) => {
    const ruleId = req.params.id
    if (!ruleId) throw badRequest('Missing rule id')

    const deleted = await deleteRule(authed(req).user.id, ruleId)
    if (!deleted) throw notFound('No such rule')

    res.status(204).end()
  }),
)

import { randomUUID } from 'node:crypto'
import { db } from '../index.js'

export type CleanupSchedule = 'manual' | 'daily' | 'weekly'

export interface RuleRow {
  id: string
  account_id: string
  query: string
  /**
   * Always 'trash'. The column exists so the intent is legible in the data,
   * and the CHECK constraint in the schema makes any other value impossible —
   * a scheduled irreversible delete is the most dangerous thing this codebase
   * could grow, so it is blocked at the storage layer, not just in code.
   */
  action: 'trash'
  schedule: CleanupSchedule
  enabled: number
  last_run_at: string | null
  created_at: string
}

export async function createRule(params: {
  accountId: string
  query: string
  schedule: CleanupSchedule
}): Promise<RuleRow> {
  const id = randomUUID()

  await db().execute({
    sql: `INSERT INTO cleanup_rules (id, account_id, query, action, schedule)
          VALUES (?, ?, ?, 'trash', ?)`,
    args: [id, params.accountId, params.query.trim(), params.schedule],
  })

  const rule = await findRuleById(id)
  if (!rule) throw new Error('Failed to create rule')
  return rule
}

export async function findRuleById(id: string): Promise<RuleRow | null> {
  const result = await db().execute({
    sql: 'SELECT * FROM cleanup_rules WHERE id = ?',
    args: [id],
  })
  return (result.rows[0] as unknown as RuleRow) ?? null
}

/**
 * Ownership is enforced by joining through connected_accounts rather than
 * trusted to the caller — a rule ID alone must never reach someone else's data.
 */
export async function findRuleForOwner(
  ownerId: string,
  ruleId: string,
): Promise<RuleRow | null> {
  const result = await db().execute({
    sql: `SELECT r.* FROM cleanup_rules r
          JOIN connected_accounts a ON a.id = r.account_id
          WHERE r.id = ? AND a.owner_id = ?`,
    args: [ruleId, ownerId],
  })
  return (result.rows[0] as unknown as RuleRow) ?? null
}

export async function listRulesForOwner(ownerId: string): Promise<RuleRow[]> {
  const result = await db().execute({
    sql: `SELECT r.* FROM cleanup_rules r
          JOIN connected_accounts a ON a.id = r.account_id
          WHERE a.owner_id = ?
          ORDER BY r.created_at DESC`,
    args: [ownerId],
  })
  return result.rows as unknown as RuleRow[]
}

export async function setRuleEnabled(
  ownerId: string,
  ruleId: string,
  enabled: boolean,
): Promise<boolean> {
  const result = await db().execute({
    sql: `UPDATE cleanup_rules SET enabled = ?
          WHERE id = ? AND account_id IN (
            SELECT id FROM connected_accounts WHERE owner_id = ?
          )`,
    args: [enabled ? 1 : 0, ruleId, ownerId],
  })
  return result.rowsAffected === 1
}

export async function deleteRule(
  ownerId: string,
  ruleId: string,
): Promise<boolean> {
  const result = await db().execute({
    sql: `DELETE FROM cleanup_rules
          WHERE id = ? AND account_id IN (
            SELECT id FROM connected_accounts WHERE owner_id = ?
          )`,
    args: [ruleId, ownerId],
  })
  return result.rowsAffected === 1
}

export async function markRuleRun(ruleId: string): Promise<void> {
  await db().execute({
    sql: `UPDATE cleanup_rules SET last_run_at = datetime('now') WHERE id = ?`,
    args: [ruleId],
  })
}

/**
 * Rules the scheduler should run now: enabled, scheduled, and not run within
 * their interval. Filtered in SQL so a missed tick cannot cause a double run.
 */
export async function findDueRules(): Promise<
  (RuleRow & { owner_id: string })[]
> {
  const result = await db().execute(`
    SELECT r.*, a.owner_id
    FROM cleanup_rules r
    JOIN connected_accounts a ON a.id = r.account_id
    WHERE r.enabled = 1
      AND a.status = 'active'
      AND r.schedule IN ('daily', 'weekly')
      AND (
        r.last_run_at IS NULL
        OR (r.schedule = 'daily'  AND r.last_run_at <= datetime('now', '-1 day'))
        OR (r.schedule = 'weekly' AND r.last_run_at <= datetime('now', '-7 days'))
      )
  `)

  return result.rows as unknown as (RuleRow & { owner_id: string })[]
}

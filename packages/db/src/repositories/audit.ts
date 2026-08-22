import { randomUUID } from 'node:crypto'
import { db } from '../index.js'

export type AuditAction = 'connect' | 'disconnect' | 'trash' | 'send' | 'rule_run'

export interface AuditRow {
  id: string
  user_id: string
  account_id: string | null
  action: AuditAction
  details_json: string
  created_at: string
}

/**
 * The audit trail is the project's accountability surface — "what did this app
 * do to my mailbox" has to be answerable. Every trash and send writes here,
 * and `docs/06-testing.md` requires a test asserting the row exists.
 *
 * Details are caller-supplied and must never include message bodies or
 * tokens. Counts, queries and IDs only.
 */
export async function writeAuditEntry(params: {
  userId: string
  accountId?: string | null
  action: AuditAction
  details?: Record<string, unknown>
}): Promise<string> {
  const id = randomUUID()

  await db().execute({
    sql: `INSERT INTO audit_log (id, user_id, account_id, action, details_json)
          VALUES (?, ?, ?, ?, ?)`,
    args: [
      id,
      params.userId,
      params.accountId ?? null,
      params.action,
      JSON.stringify(params.details ?? {}),
    ],
  })

  return id
}

export async function listAuditForUser(
  userId: string,
  limit = 50,
): Promise<AuditRow[]> {
  const result = await db().execute({
    sql: `SELECT * FROM audit_log
          WHERE user_id = ?
          ORDER BY created_at DESC
          LIMIT ?`,
    args: [userId, limit],
  })
  return result.rows as unknown as AuditRow[]
}

import { randomUUID } from 'node:crypto'
import { db } from '../index.js'

export interface SessionRow {
  id: string
  user_id: string
  expires_at: string
  created_at: string
}

/**
 * Only the hash is stored. The raw token lives in the user's cookie and
 * nowhere else, so a database disclosure does not hand over live sessions.
 */
export async function createSession(
  userId: string,
  tokenHash: string,
  expiresAt: Date,
): Promise<SessionRow> {
  const id = randomUUID()

  await db().execute({
    sql: `INSERT INTO sessions (id, user_id, token_hash, expires_at)
          VALUES (?, ?, ?, ?)`,
    args: [id, userId, tokenHash, expiresAt.toISOString()],
  })

  return {
    id,
    user_id: userId,
    expires_at: expiresAt.toISOString(),
    created_at: new Date().toISOString(),
  }
}

/**
 * Expiry is filtered in SQL rather than in the caller, so there is no path
 * where a stale row is fetched and the check is forgotten.
 */
export async function findValidSession(
  tokenHash: string,
): Promise<SessionRow | null> {
  const result = await db().execute({
    sql: `SELECT id, user_id, expires_at, created_at
          FROM sessions
          WHERE token_hash = ? AND expires_at > datetime('now')`,
    args: [tokenHash],
  })
  return (result.rows[0] as unknown as SessionRow) ?? null
}

export async function deleteSession(tokenHash: string): Promise<void> {
  await db().execute({
    sql: 'DELETE FROM sessions WHERE token_hash = ?',
    args: [tokenHash],
  })
}

/** Used by "log out everywhere", and after any credential-level change. */
export async function deleteAllSessionsForUser(userId: string): Promise<void> {
  await db().execute({
    sql: 'DELETE FROM sessions WHERE user_id = ?',
    args: [userId],
  })
}

export async function deleteExpiredSessions(): Promise<number> {
  const result = await db().execute(
    "DELETE FROM sessions WHERE expires_at <= datetime('now')",
  )
  return result.rowsAffected
}

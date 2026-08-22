import { randomUUID } from 'node:crypto'
import { db } from '../index.js'
import { normaliseEmail } from './users.js'

export interface OtpRow {
  id: string
  email: string
  code_hash: string
  expires_at: string
  consumed_at: string | null
  attempts: number
}

/** Wrong guesses allowed before the code is dead, regardless of expiry. */
export const MAX_OTP_ATTEMPTS = 5

/**
 * Issuing a new code invalidates any earlier unconsumed one for that address.
 * Without this, every resend would widen the window an attacker can guess in
 * — several live codes at once is strictly worse than one.
 */
export async function createOtp(
  email: string,
  codeHash: string,
  expiresAt: Date,
): Promise<string> {
  const normalised = normaliseEmail(email)
  const id = randomUUID()

  await db().batch([
    {
      sql: `UPDATE login_otps SET consumed_at = datetime('now')
            WHERE email = ? AND consumed_at IS NULL`,
      args: [normalised],
    },
    {
      sql: `INSERT INTO login_otps (id, email, code_hash, expires_at)
            VALUES (?, ?, ?, ?)`,
      args: [id, normalised, codeHash, expiresAt.toISOString()],
    },
  ])

  return id
}

export async function findActiveOtp(email: string): Promise<OtpRow | null> {
  const result = await db().execute({
    sql: `SELECT id, email, code_hash, expires_at, consumed_at, attempts
          FROM login_otps
          WHERE email = ?
            AND consumed_at IS NULL
            AND expires_at > datetime('now')
            AND attempts < ?
          ORDER BY created_at DESC
          LIMIT 1`,
    args: [normaliseEmail(email), MAX_OTP_ATTEMPTS],
  })
  return (result.rows[0] as unknown as OtpRow) ?? null
}

export async function recordFailedAttempt(id: string): Promise<void> {
  await db().execute({
    sql: 'UPDATE login_otps SET attempts = attempts + 1 WHERE id = ?',
    args: [id],
  })
}

/**
 * Single-use. The WHERE clause on consumed_at makes this idempotent under a
 * race: two simultaneous verifications of the same code, only one wins.
 */
export async function consumeOtp(id: string): Promise<boolean> {
  const result = await db().execute({
    sql: `UPDATE login_otps SET consumed_at = datetime('now')
          WHERE id = ? AND consumed_at IS NULL`,
    args: [id],
  })
  return result.rowsAffected === 1
}

/** How many codes this address has requested recently — the rate limit. */
export async function countRecentOtps(
  email: string,
  withinMinutes: number,
): Promise<number> {
  const result = await db().execute({
    sql: `SELECT COUNT(*) AS n FROM login_otps
          WHERE email = ? AND created_at > datetime('now', ?)`,
    args: [normaliseEmail(email), `-${withinMinutes} minutes`],
  })
  return Number(result.rows[0]?.n ?? 0)
}

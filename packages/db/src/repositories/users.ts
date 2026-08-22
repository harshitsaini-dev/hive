import { randomUUID } from 'node:crypto'
import { db } from '../index.js'

export interface UserRow {
  id: string
  email: string
  created_at: string
}

/** Addresses are compared lowercased; Gmail treats them case-insensitively. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase()
}

export async function findUserByEmail(email: string): Promise<UserRow | null> {
  const result = await db().execute({
    sql: 'SELECT id, email, created_at FROM users WHERE email = ?',
    args: [normaliseEmail(email)],
  })
  return (result.rows[0] as unknown as UserRow) ?? null
}

export async function findUserById(id: string): Promise<UserRow | null> {
  const result = await db().execute({
    sql: 'SELECT id, email, created_at FROM users WHERE id = ?',
    args: [id],
  })
  return (result.rows[0] as unknown as UserRow) ?? null
}

/**
 * Login is passwordless, so a first successful OTP *is* the signup. There is
 * no separate registration step to race against, but two OTPs verified at
 * once could still both try to insert — hence ON CONFLICT rather than a
 * check-then-insert.
 */
export async function upsertUserByEmail(email: string): Promise<UserRow> {
  const normalised = normaliseEmail(email)

  await db().execute({
    sql: `INSERT INTO users (id, email) VALUES (?, ?)
          ON CONFLICT(email) DO NOTHING`,
    args: [randomUUID(), normalised],
  })

  const user = await findUserByEmail(normalised)
  if (!user) throw new Error(`Failed to upsert user ${normalised}`)
  return user
}

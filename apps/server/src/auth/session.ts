import type { Response } from 'express'
import { createSession, deleteSession } from '@hive/db'
import { config } from '../config.js'
import { hashToken, randomToken } from '../crypto.js'

export const SESSION_COOKIE = 'hive_session'
const SESSION_DAYS = 30

/**
 * Issues a session and sets the cookie.
 *
 * HttpOnly so no script can read it, SameSite=Lax so it does not ride along
 * with cross-site requests (which is also what makes the OAuth redirect back
 * from Google still carry it — a strict cookie would not, and the callback
 * would look unauthenticated).
 */
export async function startSession(
  res: Response,
  userId: string,
): Promise<void> {
  const token = randomToken()
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000)

  await createSession(userId, hashToken(token), expiresAt)

  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProduction,
    expires: expiresAt,
    path: '/',
  })
}

export async function endSession(res: Response, token: string): Promise<void> {
  // Delete the row first: clearing the cookie alone would leave a usable
  // session for anyone who copied the token.
  await deleteSession(hashToken(token))

  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProduction,
    path: '/',
  })
}

import type { NextFunction, Request, Response } from 'express'
import { findUserById, findValidSession } from '@hive/db'
import { hashToken } from '../crypto.js'
import { unauthorized } from '../errors.js'
import { SESSION_COOKIE } from '../auth/session.js'

export interface AuthedRequest extends Request {
  user: { id: string; email: string }
  sessionToken: string
}

/**
 * Deny by default. Any route that reads or writes user data mounts this, and
 * downstream handlers can rely on `req.user` existing rather than re-checking.
 */
export async function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const token = (req.cookies as Record<string, string> | undefined)?.[
      SESSION_COOKIE
    ]

    if (!token) {
      next(unauthorized('Sign in to continue'))
      return
    }

    const session = await findValidSession(hashToken(token))
    if (!session) {
      // Covers expired, revoked and forged tokens alike. Saying which would
      // tell an attacker whether a token was ever real.
      next(unauthorized('Your session has expired'))
      return
    }

    const user = await findUserById(session.user_id)
    if (!user) {
      // The account was deleted while a session was still live.
      next(unauthorized('Your session has expired'))
      return
    }

    Object.assign(req, {
      user: { id: user.id, email: user.email },
      sessionToken: token,
    })

    next()
  } catch (error) {
    next(error)
  }
}

/** Narrows within a handler mounted behind requireAuth. */
export function authed(req: Request): AuthedRequest {
  const candidate = req as AuthedRequest
  if (!candidate.user) {
    throw new Error('authed() used on a route without requireAuth')
  }
  return candidate
}

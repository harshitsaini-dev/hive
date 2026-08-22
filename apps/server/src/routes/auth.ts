import { Router } from 'express'
import { z } from 'zod'
import {
  consumeOtp,
  countRecentOtps,
  createOtp,
  findActiveOtp,
  normaliseEmail,
  recordFailedAttempt,
  upsertUserByEmail,
} from '@hive/db'
import { config } from '../config.js'
import { hashToken, randomOtpCode, safeEqual } from '../crypto.js'
import { sendOtpEmail } from '../email.js'
import { asyncRoute, badRequest, tooManyRequests } from '../errors.js'
import { authed, requireAuth } from '../middleware/auth.js'
import { rateLimit, resetRateLimits } from '../middleware/rate-limit.js'
import { endSession, startSession } from '../auth/session.js'

export const authRouter: Router = Router()

const OTP_TTL_MINUTES = 10
const RATE_WINDOW_MINUTES = 15
const MAX_CODES_PER_WINDOW = 5

/**
 * Codes are only ever stored hashed, so nothing can read one back — which is
 * correct, and also means automated tests have no way to complete a login.
 *
 * Outside production the plaintext is mirrored here, in memory, and exposed by
 * the test-only route at the bottom of this file. It is never populated when
 * NODE_ENV=production, so there is no path to it on a deployed instance.
 */
const devCodes = new Map<string, string>()

const requestSchema = z.object({
  email: z.string().trim().email('Enter a valid email address').max(254),
})

const verifySchema = z.object({
  email: z.string().trim().email().max(254),
  code: z.string().trim().regex(/^\d{6}$/, 'Enter the six-digit code'),
})

/**
 * POST /auth/otp/request
 *
 * Always answers the same way whether or not the address is known. Telling
 * callers which addresses have accounts would turn this into a membership
 * oracle, and there is no product reason to.
 */
authRouter.post(
  '/otp/request',
  asyncRoute(async (req, res) => {
    const parsed = requestSchema.safeParse(req.body)
    if (!parsed.success) {
      throw badRequest(
        parsed.error.issues[0]?.message ?? 'Invalid request',
      )
    }

    const email = normaliseEmail(parsed.data.email)

    const recent = await countRecentOtps(email, RATE_WINDOW_MINUTES)
    if (recent >= MAX_CODES_PER_WINDOW) {
      throw tooManyRequests(
        `Too many codes requested. Try again in ${RATE_WINDOW_MINUTES} minutes.`,
      )
    }

    const code = randomOtpCode()
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60_000)

    await createOtp(email, hashToken(code), expiresAt)

    if (!config.isProduction) devCodes.set(email, code)

    try {
      await sendOtpEmail(email, code)
    } catch (error) {
      // The row is already written, so a delivery failure must not look like
      // success — the user would sit waiting for mail that is not coming.
      console.error('failed to deliver login code:', error)
      throw badRequest('Could not send the login code. Try again shortly.')
    }

    res.status(202).json({ sent: true, expiresInMinutes: OTP_TTL_MINUTES })
  }),
)

/**
 * POST /auth/otp/verify
 *
 * A correct code both creates the account (first time) and signs in — there
 * is no separate registration step in a passwordless flow.
 */
authRouter.post(
  '/otp/verify',
  asyncRoute(async (req, res) => {
    const parsed = verifySchema.safeParse(req.body)
    if (!parsed.success) {
      throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid request')
    }

    const email = normaliseEmail(parsed.data.email)
    const otp = await findActiveOtp(email)

    // One message for "no code outstanding", "expired", "too many attempts"
    // and "wrong digits". Distinguishing them helps an attacker far more than
    // it helps a user, who should simply request a new code.
    const rejection = badRequest('That code is not valid. Request a new one.')

    if (!otp) throw rejection

    if (!safeEqual(hashToken(parsed.data.code), otp.code_hash)) {
      await recordFailedAttempt(otp.id)
      throw rejection
    }

    // Single-use. Loses the race if the same code is verified twice at once.
    if (!(await consumeOtp(otp.id))) throw rejection

    const user = await upsertUserByEmail(email)
    await startSession(res, user.id)

    res.json({ user: { id: user.id, email: user.email } })
  }),
)

/** GET /auth/me — who the session belongs to. */
authRouter.get(
  '/me',
  requireAuth,
  asyncRoute(async (req, res) => {
    res.json({ user: authed(req).user })
  }),
)

/** POST /auth/logout — revokes the session server-side, not just the cookie. */
authRouter.post(
  '/logout',
  requireAuth,
  asyncRoute(async (req, res) => {
    await endSession(res, authed(req).sessionToken)
    res.status(204).end()
  }),
)

/**
 * GET /auth/test/last-code — the most recent code for an address.
 *
 * Registered only outside production. Without it the e2e suite cannot log in,
 * because codes are stored hashed by design. The route is not merely gated at
 * request time: it is never mounted at all when NODE_ENV=production, so it
 * cannot be reached even if something else went wrong.
 */
if (!config.isProduction) {
  authRouter.get(
    '/test/last-code',
    asyncRoute(async (req, res) => {
      const email = normaliseEmail(String(req.query.email ?? ''))
      const code = devCodes.get(email)

      if (!code) throw badRequest('No code has been issued for that address')

      res.json({ code })
    }),
  )

  /**
   * POST /auth/test/reset-rate-limits
   *
   * The limiter buckets by IP, and every test shares one. Without a way to
   * clear it, a test that deliberately trips the limit poisons every test that
   * runs after it. Registered only outside production, same as the route above.
   */
  /**
   * GET /auth/test/rate-limit-probe
   *
   * A dedicated bucket with a tiny allowance, so the limiter can be tested
   * deterministically. Exercising the real /auth limit instead would drain a
   * bucket every other test shares, making unrelated tests fail depending on
   * execution order.
   */
  authRouter.get(
    '/test/rate-limit-probe',
    rateLimit('probe', { max: 3, windowMs: 60_000 }),
    asyncRoute(async (_req, res) => {
      res.json({ ok: true })
    }),
  )

  authRouter.post(
    '/test/reset-rate-limits',
    asyncRoute(async (_req, res) => {
      resetRateLimits()
      res.status(204).end()
    }),
  )
}

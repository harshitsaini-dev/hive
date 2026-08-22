import type { NextFunction, Request, Response } from 'express'
import { tooManyRequests } from '../errors.js'

/**
 * In-memory fixed-window rate limiting.
 *
 * Deliberately simple. This runs as a single process on a single instance, so
 * a shared store would add a dependency for no benefit today — but that is
 * exactly what changes if the backend is ever scaled horizontally, at which
 * point each instance would enforce its own separate allowance. Worth
 * revisiting before that happens, not before.
 *
 * OTP requests have their own database-backed limit in routes/auth.ts, which
 * survives restarts. This layer protects everything else.
 */

interface Window {
  count: number
  resetAt: number
}

const buckets = new Map<string, Window>()

/**
 * Sweeps expired windows so the map cannot grow without bound — an attacker
 * cycling IPs would otherwise be a slow memory leak.
 */
const SWEEP_INTERVAL_MS = 5 * 60_000

const sweeper = setInterval(() => {
  const now = Date.now()
  for (const [key, window] of buckets) {
    if (window.resetAt <= now) buckets.delete(key)
  }
}, SWEEP_INTERVAL_MS)

// Never hold the process open just to run the sweeper.
sweeper.unref()

export interface RateLimitOptions {
  /** Requests allowed per window. */
  max: number
  windowMs: number
  /** Shown to the caller. Should say what to do, not just that they failed. */
  message?: string
}

/**
 * Keys by authenticated user when there is one, falling back to IP.
 *
 * User-keyed is the more useful limit: it is the account doing the work, and
 * it cannot be sidestepped by changing address. IP is the only option before
 * sign-in.
 */
function keyFor(req: Request, name: string): string {
  const user = (req as { user?: { id: string } }).user
  return `${name}:${user ? `u:${user.id}` : `ip:${req.ip ?? 'unknown'}`}`
}

export function rateLimit(name: string, options: RateLimitOptions) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = keyFor(req, name)
    const now = Date.now()

    let window = buckets.get(key)
    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + options.windowMs }
      buckets.set(key, window)
    }

    window.count += 1

    const remaining = Math.max(0, options.max - window.count)
    res.setHeader('RateLimit-Limit', options.max)
    res.setHeader('RateLimit-Remaining', remaining)
    res.setHeader('RateLimit-Reset', Math.ceil((window.resetAt - now) / 1000))

    if (window.count > options.max) {
      const seconds = Math.ceil((window.resetAt - now) / 1000)
      res.setHeader('Retry-After', seconds)
      next(
        tooManyRequests(
          options.message ?? `Too many requests. Try again in ${seconds} seconds.`,
        ),
      )
      return
    }

    next()
  }
}

/** Test-only: lets a suite start from a clean slate. */
export function resetRateLimits(): void {
  buckets.clear()
}

/**
 * One error shape for the whole API, so the client has exactly one thing to
 * parse — and so internals never reach a user by accident.
 */
import type { NextFunction, Request, Response } from 'express'
import type { ApiError } from '@hive/shared-types'
import { config } from './config.js'

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, 'bad_request', message, details)

/** Not authenticated at all. */
export const unauthorized = (message = 'Authentication required') =>
  new HttpError(401, 'unauthorized', message)

/** Authenticated, but not allowed. Distinct from 401 on purpose. */
export const forbidden = (message = 'Not permitted') =>
  new HttpError(403, 'forbidden', message)

export const notFound = (message = 'Not found') =>
  new HttpError(404, 'not_found', message)

export const tooManyRequests = (message = 'Too many requests') =>
  new HttpError(429, 'too_many_requests', message)

export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response<ApiError>,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(error)
    return
  }

  if (error instanceof HttpError) {
    res.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    })
    return
  }

  // Anything unrecognised is a bug. Log it in full for us; tell the caller
  // nothing — stack traces and driver messages leak schema and file paths.
  console.error('unhandled error:', error)

  res.status(500).json({
    error: {
      code: 'internal_error',
      message: 'Something went wrong.',
      ...(config.isProduction
        ? {}
        : { details: error instanceof Error ? error.message : String(error) }),
    },
  })
}

/** Wraps an async handler so rejected promises reach the error middleware. */
export function asyncRoute<T extends Request>(
  handler: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: T, res: Response, next: NextFunction): void => {
    handler(req, res, next).catch(next)
  }
}

import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import express from 'express'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import { WebSocketServer } from 'ws'
import { db } from '@hive/db'
import { config } from './config.js'
import { errorHandler, asyncRoute, notFound } from './errors.js'
import { loadDevTls } from './tls.js'
import { rateLimit } from './middleware/rate-limit.js'
import { authRouter } from './routes/auth.js'
import { accountsRouter } from './routes/accounts.js'
import { messagesRouter } from './routes/messages.js'
import { rulesRouter } from './routes/rules.js'
import { applyMigrations } from '@hive/db'
import { startRuleScheduler } from './rules-runner.js'

const app = express()

app.disable('x-powered-by')

/*
 * Render and Vercel both sit in front of this process, so the socket address
 * is the proxy's, not the caller's. Without this every request looks like it
 * comes from one IP and the rate limiter buckets the whole internet together.
 * 1 = trust exactly one hop, which is what a single platform proxy is.
 */
if (config.isProduction) app.set('trust proxy', 1)
app.use(express.json({ limit: '1mb' }))
app.use(cookieParser())
app.use(
  cors({
    origin: config.WEB_ORIGIN,
    // Sessions ride in a cookie, so the browser must be allowed to send it.
    credentials: true,
  }),
)

/**
 * Liveness. Deliberately does not touch the database — a platform health
 * check that fails during a brief DB blip would restart a process that is
 * perfectly fine.
 */
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', env: config.NODE_ENV })
})

/** Readiness. This one *does* check the database, because that is the point. */
app.get(
  '/ready',
  asyncRoute(async (_req, res) => {
    try {
      await db().execute('SELECT 1')
      res.json({ status: 'ready', database: 'ok' })
    } catch (error) {
      console.error('readiness check failed:', error)
      res.status(503).json({ status: 'not_ready', database: 'unreachable' })
    }
  }),
)

/*
 * A flood guard, not the anti-brute-force control.
 *
 * /auth/me runs on every page load, so this has to sit well above real usage
 * or ordinary browsing trips it. What actually protects login codes is
 * database-backed and much tighter: five codes per address per fifteen
 * minutes, five wrong guesses per code, single use. Those survive restarts
 * and cannot be dodged by changing IP; this cannot claim either.
 */
app.use('/auth', rateLimit('auth', { max: 200, windowMs: 60_000 }), authRouter)
app.use('/accounts', accountsRouter)
/*
 * Message routes fan out to Gmail, whose own per-user quota is the scarce
 * resource. A runaway client loop would burn it for the whole account.
 */
app.use(
  '/messages',
  rateLimit('messages', {
    max: 120,
    windowMs: 60_000,
    message: 'Slow down a moment — too many mailbox requests in a row.',
  }),
  messagesRouter,
)
app.use('/rules', rulesRouter)

app.use((_req, _res, next) => next(notFound('No such endpoint')))
app.use(errorHandler)

const tls = loadDevTls()
const scheme = tls ? 'https' : 'http'

// TLS locally, plain HTTP in production where the platform terminates it.
const server = tls ? createHttpsServer(tls, app) : createHttpServer(app)

/**
 * Bulk-trash progress. Attached to the same HTTP server so there is one port
 * and one origin to configure. Connections are authenticated in Phase 3 when
 * there are actually jobs to report on.
 */
const wss = new WebSocketServer({ server, path: '/ws' })
wss.on('connection', (socket) => {
  socket.on('error', (error) => console.error('websocket error:', error))
})

/*
 * Bring the schema up to date before serving.
 *
 * A deploy used to ship code needing a table that only existed once someone
 * remembered to run `npm run db:migrate` from a laptop. When they did not,
 * the app failed at the point of use rather than at boot, and the error it
 * produced pointed at Gmail rather than at the schema.
 *
 * Logged and continued rather than fatal: refusing to boot over a transient
 * database hiccup would take the whole service down, and every route already
 * fails on its own terms if a table really is missing.
 */
void applyMigrations().catch((error: unknown) => {
  console.error('could not apply migrations at startup:', error)
})

startRuleScheduler()

server.listen(config.PORT, () => {
  console.log(`hive server on ${scheme}://localhost:${config.PORT}  [${config.NODE_ENV}]`)
  if (!tls && !config.isProduction) {
    console.warn(
      'no local certificate found — run: sh scripts/make-cert.sh\n' +
        '  (Google will not issue the restricted scope over plain HTTP)',
    )
  }
  if (!config.canSendEmail) {
    console.warn('RESEND_API_KEY is unset — login codes will not be delivered.')
  }
})

/** Render and friends send SIGTERM; finish in-flight requests before exiting. */
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`)
    wss.close()
    server.close(() => process.exit(0))
    // Do not hang forever on a stuck connection.
    setTimeout(() => process.exit(1), 10_000).unref()
  })
}

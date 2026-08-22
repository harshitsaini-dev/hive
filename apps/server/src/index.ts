import { createServer } from 'node:http'
import express from 'express'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import { WebSocketServer } from 'ws'
import { db } from '@hive/db'
import { config } from './config.js'
import { errorHandler, asyncRoute, notFound } from './errors.js'

const app = express()

app.disable('x-powered-by')
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

// Routes land here as phases progress: /auth, /accounts, /messages, /rules.

app.use((_req, _res, next) => next(notFound('No such endpoint')))
app.use(errorHandler)

const server = createServer(app)

/**
 * Bulk-trash progress. Attached to the same HTTP server so there is one port
 * and one origin to configure. Connections are authenticated in Phase 3 when
 * there are actually jobs to report on.
 */
const wss = new WebSocketServer({ server, path: '/ws' })
wss.on('connection', (socket) => {
  socket.on('error', (error) => console.error('websocket error:', error))
})

// Cleanup-rule scheduling is registered here in Phase 5.

server.listen(config.PORT, () => {
  console.log(`hive server on http://localhost:${config.PORT}  [${config.NODE_ENV}]`)
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

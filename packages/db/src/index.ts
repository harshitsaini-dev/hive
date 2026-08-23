import { createClient, type Client } from '@libsql/client'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type { Client }

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/**
 * Anchored to the repo root rather than the working directory: the migrate
 * script runs from packages/db and the server from apps/server, and a relative
 * path would quietly give them two different databases.
 */
const DEFAULT_DEV_DB = `file:${join(REPO_ROOT, 'local.db')}`

/**
 * Turso in deployed environments; a local SQLite file in development, so the
 * project boots with no accounts and no network. `file:` URLs are handled by
 * the same libsql client, which keeps dev and production on one code path.
 */
export function createDbClient(): Client {
  const url = process.env.TURSO_DATABASE_URL?.trim() || DEFAULT_DEV_DB
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim()

  const isRemote = url.startsWith('libsql://') || url.startsWith('https://')
  if (isRemote && !authToken) {
    throw new Error(
      'TURSO_AUTH_TOKEN is required when TURSO_DATABASE_URL points at a remote database.',
    )
  }

  return createClient(isRemote ? { url, authToken } : { url })
}

export * from './repositories/users.js'
export * from './repositories/sessions.js'
export * from './repositories/otps.js'
export * from './repositories/accounts.js'
export * from './repositories/audit.js'
export * from './repositories/rules.js'
export * from './repositories/analysis.js'
export * from './repositories/messages.js'
export { applyMigrations } from './migrate.js'

let shared: Client | undefined

/** Process-wide client. Cheap to reuse; do not create one per request. */
export function db(): Client {
  shared ??= createDbClient()
  return shared
}

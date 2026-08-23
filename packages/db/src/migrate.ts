/**
 * Applies every .sql file in ../migrations, in filename order, exactly once.
 *
 * Deliberately minimal — no down-migrations. Rolling back a schema change in
 * production is done by writing a new forward migration, which is both safer
 * and honest about what actually happens. See docs/06-testing.md for how the
 * test database is reset.
 */
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createDbClient } from './index.js'

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

/**
 * Applies anything outstanding and reports how many.
 *
 * Exported so the server can run it at boot. It used to be reachable only
 * through `npm run db:migrate` from a laptop, which meant a deploy could ship
 * code that needed a table nobody had created — and the resulting failure
 * surfaced as a mailbox error, pointing the investigation at Gmail instead of
 * at the schema.
 */
export async function applyMigrations(): Promise<number> {
  const client = createDbClient()

  await client.execute(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  const applied = new Set(
    (await client.execute('SELECT name FROM _migrations')).rows.map(
      (row) => row.name as string,
    ),
  )

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((name) => name.endsWith('.sql'))
    .sort()

  let count = 0
  for (const file of files) {
    if (applied.has(file)) continue

    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8')

    // executeMultiple runs the whole file as one batch. If any statement
    // fails the migration is not recorded, so a fixed file re-runs cleanly.
    await client.executeMultiple(sql)
    await client.execute({
      sql: 'INSERT INTO _migrations (name) VALUES (?)',
      args: [file],
    })

    console.log(`applied ${file}`)
    count++
  }

  console.log(count === 0 ? 'already up to date' : `${count} migration(s) applied`)
  client.close()
  return count
}

/*
 * Only when run directly, not when the server imports it.
 *
 * Compared as file URLs rather than paths: on Windows `process.argv[1]` is a
 * backslashed path and `import.meta.url` is a `file://` URL, so a plain string
 * comparison never matches and the CLI silently does nothing.
 */
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  applyMigrations().catch((error: unknown) => {
    console.error('migration failed:', error)
    process.exitCode = 1
  })
}

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
import { fileURLToPath } from 'node:url'
import { createDbClient } from './index.js'

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

async function main(): Promise<void> {
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
}

main().catch((error: unknown) => {
  console.error('migration failed:', error)
  process.exitCode = 1
})

import { db } from '../index.js'

/**
 * The last mailbox analysis a user ran.
 *
 * Persisted rather than cached in the browser because a run is expensive —
 * reading who sent a message costs a Gmail request per message — and because
 * the result should be there on whatever device they sign in from next.
 *
 * Only counts and sender addresses are stored. Message content never reaches
 * this database; see the migration for the full note.
 */
export interface AnalysisRunRow {
  user_id: string
  account_id: string | null
  query: string
  filters_json: string
  result_json: string
  finished_at: string
}

export async function saveAnalysisRun(params: {
  userId: string
  accountId: string | null
  query: string
  filters: unknown
  result: unknown
}): Promise<void> {
  // One row per user, replaced outright. A history would grow without bound
  // for a feature that only ever answers "what does my mailbox look like now".
  await db().execute({
    sql: `INSERT INTO analysis_runs
            (user_id, account_id, query, filters_json, result_json, finished_at)
          VALUES (?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(user_id) DO UPDATE SET
            account_id   = excluded.account_id,
            query        = excluded.query,
            filters_json = excluded.filters_json,
            result_json  = excluded.result_json,
            finished_at  = excluded.finished_at`,
    args: [
      params.userId,
      params.accountId,
      params.query,
      JSON.stringify(params.filters ?? {}),
      JSON.stringify(params.result ?? null),
    ],
  })
}

export async function findAnalysisRun(
  userId: string,
): Promise<AnalysisRunRow | null> {
  const result = await db().execute({
    sql: 'SELECT * FROM analysis_runs WHERE user_id = ?',
    args: [userId],
  })

  return (result.rows[0] as unknown as AnalysisRunRow | undefined) ?? null
}

export async function deleteAnalysisRun(userId: string): Promise<void> {
  await db().execute({
    sql: 'DELETE FROM analysis_runs WHERE user_id = ?',
    args: [userId],
  })
}

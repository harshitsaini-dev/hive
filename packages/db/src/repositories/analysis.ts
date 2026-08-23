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

export type AnalysisCadence = 'daily' | 'weekly'

export interface AnalysisScheduleRow {
  user_id: string
  enabled: number
  cadence: AnalysisCadence
  minute_utc: number
  account_id: string | null
  query: string
  scan_limit: number
  filters_json: string
  last_run_at: string | null
}

export async function saveAnalysisSchedule(params: {
  userId: string
  enabled: boolean
  cadence: AnalysisCadence
  minuteUtc: number
  accountId: string | null
  query: string
  scanLimit: number
  filters: unknown
}): Promise<void> {
  await db().execute({
    sql: `INSERT INTO analysis_schedules
            (user_id, enabled, cadence, minute_utc, account_id, query,
             scan_limit, filters_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET
            enabled      = excluded.enabled,
            cadence      = excluded.cadence,
            minute_utc   = excluded.minute_utc,
            account_id   = excluded.account_id,
            query        = excluded.query,
            scan_limit   = excluded.scan_limit,
            filters_json = excluded.filters_json`,
    args: [
      params.userId,
      params.enabled ? 1 : 0,
      params.cadence,
      params.minuteUtc,
      params.accountId,
      params.query,
      params.scanLimit,
      JSON.stringify(params.filters ?? {}),
    ],
  })
}

export async function findAnalysisSchedule(
  userId: string,
): Promise<AnalysisScheduleRow | null> {
  const result = await db().execute({
    sql: 'SELECT * FROM analysis_schedules WHERE user_id = ?',
    args: [userId],
  })

  return (result.rows[0] as unknown as AnalysisScheduleRow | undefined) ?? null
}

export async function deleteAnalysisSchedule(userId: string): Promise<void> {
  await db().execute({
    sql: 'DELETE FROM analysis_schedules WHERE user_id = ?',
    args: [userId],
  })
}

/**
 * Schedules that should run now.
 *
 * Due-ness is decided in SQL from the row's own `last_run_at`, not from when
 * the process happens to be awake — so a restart cannot cause a scheduled run
 * to be skipped entirely, the way a fixed in-memory timer would.
 *
 * The time check is deliberately `>=` rather than `=`: if the instance was
 * asleep at 03:00 (a free tier spins down), the run should still happen when
 * it wakes at 05:00, not be lost until tomorrow.
 */
export async function findDueAnalysisSchedules(): Promise<
  AnalysisScheduleRow[]
> {
  const result = await db().execute({
    sql: `SELECT * FROM analysis_schedules
          WHERE enabled = 1
            AND (CAST(strftime('%H', 'now') AS INTEGER) * 60
                 + CAST(strftime('%M', 'now') AS INTEGER)) >= minute_utc
            AND (
              last_run_at IS NULL
              OR (cadence = 'daily'  AND last_run_at < datetime('now', '-20 hours'))
              OR (cadence = 'weekly' AND last_run_at < datetime('now', '-6 days'))
            )`,
    args: [],
  })

  return result.rows as unknown as AnalysisScheduleRow[]
}

export async function markAnalysisScheduleRun(userId: string): Promise<void> {
  await db().execute({
    sql: `UPDATE analysis_schedules SET last_run_at = datetime('now')
          WHERE user_id = ?`,
    args: [userId],
  })
}

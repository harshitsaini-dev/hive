/**
 * Executes cleanup rules, on demand and on a schedule.
 *
 * The single most important property of this file: **a rule only ever
 * trashes.** It calls trashMessages and nothing else. Permanent deletion is
 * irreversible, and an automated irreversible action against a query someone
 * wrote weeks ago is the worst failure mode this project has available to it.
 * See ADR 0002 and CLAUDE.md.
 */
import cron, { type ScheduledTask } from 'node-cron'
import {
  findDueRules,
  listAllActiveAccounts,
  listSyncStates,
  markRuleRun,
  writeAuditEntry,
  type RuleRow,
} from '@hive/db'
import { listAllMessageIds, trashMessages } from '@hive/gmail-client'
import { syncAccount } from './sync.js'
import { withGmail } from './gmail.js'

/**
 * Ceiling on a single rule run.
 *
 * A rule runs unattended, so a query that silently matches an entire mailbox
 * would trash it without anyone watching. The cap bounds that, and the count
 * is recorded so a truncated run is visible afterwards rather than looking
 * like a complete one.
 */
const MAX_PER_RUN = 5000

export interface RuleRunResult {
  trashed: number
  truncated: boolean
}

export async function runRule(
  ownerId: string,
  rule: RuleRow,
): Promise<RuleRunResult> {
  return withGmail(ownerId, rule.account_id, async (session) => {
    // Never touch what is already in the bin: a rule like `older_than:30d`
    // would otherwise re-trash trashed mail on every run, inflating the audit
    // trail with work that does nothing.
    const query = `${rule.query} -in:trash`

    const { ids, truncated } = await listAllMessageIds(
      session.accessToken,
      query,
      MAX_PER_RUN,
    )

    if (ids.length > 0) {
      await trashMessages(session.accessToken, ids)
    }

    await writeAuditEntry({
      userId: ownerId,
      accountId: rule.account_id,
      action: 'rule_run',
      details: {
        ruleId: rule.id,
        query: rule.query,
        trashed: ids.length,
        truncated,
      },
    })

    await markRuleRun(rule.id)

    return { trashed: ids.length, truncated }
  })
}

let task: ScheduledTask | undefined
let syncTask: ScheduledTask | undefined

/**
 * How often the index sweep runs, and the one place that answer lives.
 *
 * Exported because the Accounts view says when the next pass is due, and a UI
 * that guesses the schedule is a UI that goes quietly wrong the day the
 * schedule changes.
 */
export const SYNC_CRON = '*/10 * * * *'
export const SYNC_INTERVAL_MINUTES = 10

/** When the next sweep is due, in ISO form, for anything that reports it. */
export function nextSyncAt(now = new Date()): string {
  const next = new Date(now)
  next.setSeconds(0, 0)
  next.setMinutes(
    (Math.floor(now.getMinutes() / SYNC_INTERVAL_MINUTES) + 1) *
      SYNC_INTERVAL_MINUTES,
  )
  return next.toISOString()
}

/** Stored by this server, but parsed defensively: an older shape is not a crash. */
function safeFilters(json: string): Record<string, string> {
  try {
    const parsed = JSON.parse(json) as unknown
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, string>)
      : {}
  } catch {
    return {}
  }
}

/**
 * Checks hourly for rules that are due.
 *
 * Hourly rather than at a fixed time of day so a restart cannot cause a
 * schedule to be skipped entirely — whether a rule is due is decided in SQL
 * from its own last_run_at, not from when the process happens to be awake.
 */
export function startRuleScheduler(): void {
  if (task) return

  task = cron.schedule('0 * * * *', () => {
    void (async () => {
      let due
      try {
        due = await findDueRules()
      } catch (error) {
        console.error('could not load due cleanup rules:', error)
        return
      }

      if (due.length === 0) return
      console.log(`running ${due.length} due cleanup rule(s)`)

      for (const rule of due) {
        try {
          const result = await runRule(rule.owner_id, rule)
          console.log(
            `rule ${rule.id}: trashed ${result.trashed}${result.truncated ? ' (truncated)' : ''}`,
          )
        } catch (error) {
          // One broken rule — usually an account needing reconnection — must
          // not stop the others from running.
          console.error(`rule ${rule.id} failed:`, error)
        }
      }
    })()
  })

  /*
   * The index sweep. One pass per account per tick, rather than looping until
   * a mailbox is done: a hundred-thousand-message backfill is hours of work,
   * and finishing one account before starting the next would leave every
   * other mailbox cold for those hours.
   *
   * Every ten minutes, not hourly. Hourly made a backfill feel stalled — six
   * times fewer passes for the same mailbox — and it meant a pass lost to a
   * rate limit cost a full hour before anything tried again, which is what
   * made "Index now" feel compulsory. An incremental pass is one history
   * call, so the quiet case costs almost nothing to repeat.
   */
  syncTask = cron.schedule(SYNC_CRON, () => {
    void (async () => {
      let accounts
      try {
        accounts = await listAllActiveAccounts()
      } catch (error) {
        console.error('could not load accounts to sync:', error)
        return
      }

      const states = await listSyncStates(accounts.map((row) => row.id))
      const paused = new Set(
        states.filter((state) => state.paused === 1).map((s) => s.account_id),
      )

      for (const account of accounts) {
        if (paused.has(account.id)) continue

        try {
          const outcome = await syncAccount(account.owner_id, account)
          if (outcome.indexed > 0 || outcome.removed > 0 || outcome.reindexed) {
            console.log(
              `sync ${account.id}: +${outcome.indexed} -${outcome.removed}` +
                `${outcome.reindexed ? ' (re-indexing)' : ''}` +
                `${outcome.backfillDone ? '' : ' (backfilling)'}`,
            )
          }
        } catch (error) {
          // Usually an account needing reconnection. Recorded on the row by
          // syncAccount itself, so the UI can say which one and why.
          console.error(`sync for ${account.id} failed:`, error)
        }
      }
    })()
  })
}

export function stopRuleScheduler(): void {
  task?.stop()
  task = undefined
  syncTask?.stop()
  syncTask = undefined
}

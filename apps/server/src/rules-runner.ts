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
  markRuleRun,
  writeAuditEntry,
  type RuleRow,
} from '@hive/db'
import { listAllMessageIds, trashMessages } from '@hive/gmail-client'
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
}

export function stopRuleScheduler(): void {
  task?.stop()
  task = undefined
}

import type { ConnectedAccount } from '@hive/shared-types'
import { ScheduleIcon } from '../Icons.js'
import { RulesPanel } from '../RulesPanel.js'
import { RuleListSkeleton, Skeleton } from '../Skeleton.js'

export function RulesView({
  accounts,
  loading,
}: {
  accounts: ConnectedAccount[]
  loading: boolean
}) {
  return (
    <section className="view">
      <header className="view__head">
        <h1>
          <ScheduleIcon size={20} />
          Cleanup rules
        </h1>
        <p className="hint">
          Saved searches that move matches to Trash on a schedule.
        </p>
      </header>

      {loading ? (
        <div className="card" aria-hidden="true">
          <Skeleton width="9rem" height="1.1rem" />
          <Skeleton height="2.5rem" radius="0.5rem" />
          <RuleListSkeleton />
        </div>
      ) : (
        <RulesPanel accounts={accounts} />
      )}
    </section>
  )
}

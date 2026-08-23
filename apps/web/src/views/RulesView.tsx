import type { ConnectedAccount } from '@hive/shared-types'
import { ScheduleIcon } from '../Icons.js'
import { AnalysisScheduleCard } from '../AnalysisSchedule.js'
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
        <>
          {/*
            Scheduled work lives together. A cleanup rule and a scheduled
            analysis are the same kind of promise — something Hive does while
            nobody is watching — and the difference between them matters
            enough to be visible side by side: one moves mail, the other only
            counts it.
          */}
          <AnalysisScheduleCard accounts={accounts} />
          <RulesPanel accounts={accounts} />
        </>
      )}
    </section>
  )
}

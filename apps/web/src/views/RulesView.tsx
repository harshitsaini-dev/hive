import type { ConnectedAccount } from '@hive/shared-types'
import { ScheduleIcon } from '../Icons.js'
import { IndexingPanel } from '../IndexingPanel.js'
import { RulesPanel } from '../RulesPanel.js'
import { RuleListSkeleton, Skeleton } from '../Skeleton.js'

export function RulesView({
  accounts,
  loading,
  onChanged,
}: {
  accounts: ConnectedAccount[]
  loading: boolean
  /** Re-reads the accounts, so indexing progress actually moves on screen. */
  onChanged: () => Promise<void> | void
}) {
  return (
    <section className="view view--wide view--rules">
      <header className="view__head">
        <h1>
          <ScheduleIcon size={20} />
          Cleanup rules
        </h1>
        <p className="hint">
          Saved searches that move matches to Trash on a schedule, and the
          background index they run alongside.
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
            Side by side where there is room, rules on the right.
            The index draws a row per connected mailbox — forty of them — so
            stacked, whichever card went second was effectively hidden. In two
            columns neither is buried, and the long list has somewhere to be
            long. Below 68rem they stack again, rules first, because on a
            phone the top of the page is the only place anyone looks.
          */}
          <div className="rulesgrid">
            <div className="rulesgrid__index">
              <IndexingPanel accounts={accounts} onChanged={onChanged} />
            </div>
            <div className="rulesgrid__rules">
              <RulesPanel accounts={accounts} />
            </div>
          </div>
        </>
      )}
    </section>
  )
}

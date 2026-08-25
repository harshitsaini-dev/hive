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
    <section className="view view--wide">
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
            Rules first, index second.
            Background work lives together — a cleanup rule and the index are
            both things Hive does while nobody is watching — but the index
            draws a row per connected mailbox, and nineteen of those pushed
            the thing this page is named after off the bottom of the screen.
            The shorter, and the reason anyone came here, goes on top.
          */}
          <RulesPanel accounts={accounts} />
          <IndexingPanel accounts={accounts} onChanged={onChanged} />
        </>
      )}
    </section>
  )
}

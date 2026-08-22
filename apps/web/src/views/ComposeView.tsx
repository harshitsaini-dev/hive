import type { ConnectedAccount } from '@hive/shared-types'
import { ComposePanel } from '../ComposePanel.js'
import { SendIcon } from '../Icons.js'
import { Skeleton } from '../Skeleton.js'

export function ComposeView({
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
          <SendIcon size={20} />
          Compose
        </h1>
        <p className="hint">Send from any connected identity.</p>
      </header>

      {loading ? (
        <div className="card" aria-hidden="true">
          <Skeleton width="7rem" height="1.1rem" />
          <Skeleton height="2.5rem" radius="0.5rem" />
          <Skeleton height="2.5rem" radius="0.5rem" />
          <Skeleton height="7rem" radius="0.5rem" />
        </div>
      ) : (
        <ComposePanel accounts={accounts} />
      )}
    </section>
  )
}

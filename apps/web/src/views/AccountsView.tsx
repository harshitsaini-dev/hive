import { useEffect, useState } from 'react'
import type { ConnectedAccount } from '@hive/shared-types'
import { api, ApiRequestError } from '../api.js'
import { AlertIcon, CheckIcon, PlusIcon, TrashIcon } from '../Icons.js'
import { AccountListSkeleton } from '../Skeleton.js'

/** Reads the outcome the OAuth callback appended to the URL, then clears it. */
function useConnectOutcome(): string | null {
  const [outcome, setOutcome] = useState<string | null>(null)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const connected = params.get('connected')
    if (!connected) return

    const account = params.get('account')
    setOutcome(
      connected === 'ok'
        ? `Connected ${account ?? 'your account'}.`
        : connected === 'cancelled'
          ? 'Connection cancelled.'
          : 'That connection did not complete. Try again.',
    )

    // Strip the params so a refresh does not replay the message.
    window.history.replaceState({}, '', window.location.pathname)
  }, [])

  return outcome
}

export function AccountsView({
  loading,
  accounts,
  error,
  onChanged,
}: {
  loading: boolean
  accounts: ConnectedAccount[]
  error: string | null
  onChanged: () => Promise<void> | void
}) {
  const [connecting, setConnecting] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const outcome = useConnectOutcome()

  async function connect() {
    setConnecting(true)
    setActionError(null)
    try {
      const { url } = await api.startConnect()
      // Full navigation, not a popup — Google blocks its consent screen in
      // many embedded and popup contexts.
      window.location.href = url
    } catch (caught) {
      setActionError(
        caught instanceof ApiRequestError
          ? caught.message
          : 'Could not start the connection.',
      )
      setConnecting(false)
    }
  }

  async function disconnect(account: ConnectedAccount) {
    if (
      !window.confirm(
        `Disconnect ${account.gmailAddress}? Hive stops syncing it. Nothing in the mailbox itself changes.`,
      )
    ) {
      return
    }

    try {
      await api.disconnect(account.id)
      await onChanged()
    } catch (caught) {
      setActionError(
        caught instanceof ApiRequestError
          ? caught.message
          : 'Could not disconnect that account.',
      )
    }
  }

  return (
    <section className="view">
      <header className="view__head">
        <h1>
          <PlusIcon size={20} />
          Accounts
        </h1>
        <p className="hint">
          Every mailbox Hive can read, clean and send from.
        </p>
      </header>

      <div role="status" aria-live="polite">
        {outcome && (
          <p className="notice">
            <CheckIcon size={16} />
            {outcome}
          </p>
        )}
        {loading && <span className="sr-only">Loading accounts</span>}
      </div>

      <div className="card">
        <div className="card__head">
          <h2>Connected</h2>
          <button
            type="button"
            className="icon-btn"
            onClick={connect}
            disabled={connecting}
          >
            <PlusIcon size={16} />
            {connecting ? 'Opening Google…' : 'Connect Gmail'}
          </button>
        </div>

        {loading && <AccountListSkeleton />}

        {!loading && error && <p className="bad">{error}</p>}

        {!loading && !error && accounts.length === 0 && (
          <p className="hint">
            No accounts yet. Connect one to search and clean it from here.
          </p>
        )}

        {!loading && accounts.length > 0 && (
          <ul className="accounts">
            {accounts.map((account) => (
              <li key={account.id}>
                <div>
                  <strong>{account.gmailAddress}</strong>
                  {account.status === 'reauth_required' && (
                    <span className="badge badge--warn">
                      <AlertIcon size={13} />
                      Needs reconnecting
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className="link icon-btn"
                  onClick={() => void disconnect(account)}
                >
                  <TrashIcon size={15} />
                  Disconnect
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div role="alert" aria-live="assertive">
        {actionError && <p className="bad">{actionError}</p>}
      </div>
    </section>
  )
}

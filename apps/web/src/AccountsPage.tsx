import { useCallback, useEffect, useState } from 'react'
import type { ConnectedAccount } from '@hive/shared-types'
import { api, ApiRequestError, type User } from './api.js'

type Load =
  | { state: 'loading' }
  | { state: 'ready'; accounts: ConnectedAccount[] }
  | { state: 'error'; message: string }

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

export function AccountsPage({
  user,
  onSignedOut,
}: {
  user: User
  onSignedOut: () => void
}) {
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const outcome = useConnectOutcome()

  const refresh = useCallback(async () => {
    try {
      const { accounts } = await api.listAccounts()
      setLoad({ state: 'ready', accounts })
    } catch (caught) {
      setLoad({
        state: 'error',
        message:
          caught instanceof ApiRequestError
            ? caught.message
            : 'Could not load your accounts.',
      })
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function connect() {
    setConnecting(true)
    setError(null)
    try {
      const { url } = await api.startConnect()
      // Full navigation, not a popup — Google blocks its consent screen in
      // many embedded and popup contexts.
      window.location.href = url
    } catch (caught) {
      setError(
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
      await refresh()
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError
          ? caught.message
          : 'Could not disconnect that account.',
      )
    }
  }

  return (
    <main className="shell">
      <header className="topbar">
        <h1>Hive</h1>
        <div className="topbar__user">
          <span className="hint">{user.email}</span>
          <button
            type="button"
            className="link"
            onClick={() => {
              void api.logout().finally(onSignedOut)
            }}
          >
            Sign out
          </button>
        </div>
      </header>

      <div role="status" aria-live="polite">
        {outcome && <p className="notice">{outcome}</p>}
      </div>

      <section className="card">
        <div className="card__head">
          <h2>Connected accounts</h2>
          <button type="button" onClick={connect} disabled={connecting}>
            {connecting ? 'Opening Google…' : 'Connect Gmail'}
          </button>
        </div>

        {load.state === 'loading' && <p className="hint">Loading…</p>}

        {load.state === 'error' && <p className="bad">{load.message}</p>}

        {load.state === 'ready' && load.accounts.length === 0 && (
          <p className="hint">
            No accounts yet. Connect one to search and clean it from here.
          </p>
        )}

        {load.state === 'ready' && load.accounts.length > 0 && (
          <ul className="accounts">
            {load.accounts.map((account) => (
              <li key={account.id}>
                <div>
                  <strong>{account.gmailAddress}</strong>
                  {account.status === 'reauth_required' && (
                    <span className="badge badge--warn">
                      Needs reconnecting
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className="link"
                  onClick={() => void disconnect(account)}
                >
                  Disconnect
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div role="alert" aria-live="assertive">
        {error && <p className="bad">{error}</p>}
      </div>
    </main>
  )
}

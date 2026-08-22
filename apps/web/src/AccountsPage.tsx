import { useCallback, useEffect, useState } from 'react'
import type { ConnectedAccount } from '@hive/shared-types'
import { api, ApiRequestError, type User } from './api.js'
import {
  AlertIcon,
  CheckIcon,
  HiveMark,
  LogoutIcon,
  MailIcon,
  PlusIcon,
  TrashIcon,
} from './Icons.js'
import { MailboxPage } from './MailboxPage.js'
import { StatusScreen } from './StatusScreen.js'
import { ThemeToggle } from './ThemeToggle.js'

type Load =
  | { state: 'loading' }
  | { state: 'ready'; accounts: ConnectedAccount[] }
  | { state: 'error'; message: string }
  | { state: 'denied' }

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
  onSessionLost,
}: {
  user: User
  onSignedOut: () => void
  onSessionLost: () => void
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
      // The session ended underneath us — expired, or revoked elsewhere.
      if (
        caught instanceof ApiRequestError &&
        (caught.status === 401 || caught.status === 403)
      ) {
        setLoad({ state: 'denied' })
        return
      }

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

  if (load.state === 'denied') {
    return (
      <StatusScreen
        kind="access-denied"
        actions={[{ label: 'Sign in again', primary: true, onClick: onSessionLost }]}
      />
    )
  }

  return (
    <main className="shell">
      <header className="topbar">
        <h1 className="brand">
          <HiveMark size={26} />
          Hive
        </h1>
        <div className="topbar__user">
          <ThemeToggle />
          <span className="hint">{user.email}</span>
          <button
            type="button"
            className="link icon-btn"
            onClick={() => {
              void api.logout().finally(onSignedOut)
            }}
          >
            <LogoutIcon size={15} />
            Sign out
          </button>
        </div>
      </header>

      <div role="status" aria-live="polite">
        {outcome && (
          <p className="notice">
            <CheckIcon size={16} />
            {outcome}
          </p>
        )}
      </div>

      <section className="card">
        <div className="card__head">
          <h2>
            <MailIcon size={17} />
            Connected accounts
          </h2>
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
      </section>

      <div role="alert" aria-live="assertive">
        {error && <p className="bad">{error}</p>}
      </div>

      {load.state === 'ready' && load.accounts.length > 0 && (
        <MailboxPage accounts={load.accounts} />
      )}
    </main>
  )
}

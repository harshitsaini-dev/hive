import { useState } from 'react'
import type { ConnectedAccount } from '@hive/shared-types'
import { api, ApiRequestError } from '../api.js'
import { ConfirmDialog } from '../ConfirmDialog.js'
import { AlertIcon, PlusIcon, SearchIcon, TrashIcon } from '../Icons.js'
import { AccountListSkeleton } from '../Skeleton.js'

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
  /** Narrows a long list of mailboxes to the one being looked for. */
  const [filter, setFilter] = useState('')
  /** The account awaiting confirmation before it is disconnected. */
  const [pendingDisconnect, setPendingDisconnect] =
    useState<ConnectedAccount | null>(null)

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
    setPendingDisconnect(null)

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

  const needle = filter.trim().toLowerCase()
  const shown = needle
    ? accounts.filter((account) =>
        account.gmailAddress.toLowerCase().includes(needle),
      )
    : accounts

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

        {/*
          Only once the list is long enough to need it — above four rows a
          search box is furniture, above forty it is the only way to reach one.
        */}
        {!loading && accounts.length > 5 && (
          <div className="search-field accounts__find">
            <SearchIcon size={15} />
            <label htmlFor="accounts-search" className="sr-only">
              Find a mailbox
            </label>
            <input
              id="accounts-search"
              type="search"
              value={filter}
              placeholder="Find a mailbox"
              onChange={(event) => setFilter(event.target.value)}
            />
          </div>
        )}

        {!loading && accounts.length > 0 && shown.length === 0 && (
          <p className="hint">No mailbox matches “{filter}”.</p>
        )}

        {!loading && shown.length > 0 && (
          <ul className="accounts">
            {shown.map((account) => (
              <li key={account.id}>
                <div className="accounts__who">
                  <strong>{account.gmailAddress}</strong>
                  {account.status === 'reauth_required' && (
                    <span className="badge badge--warn">
                      <AlertIcon size={13} />
                      Needs reconnecting
                    </span>
                  )}

                  {/*
                    Indexing progress, said plainly. A backfill on a large
                    mailbox is hours of work; leaving it invisible makes the
                    analysis panel look inconsistent for no apparent reason —
                    fast for one account, slow for another.
                  */}
                  {/*
                    What recipients will actually see. Worth stating rather
                    than leaving to be discovered by sending something: an
                    alias with no display name of its own makes Gmail fall
                    back to the local part of the address.
                  */}
                  <span className="hint accounts__sends">
                    {account.senderName
                      ? `Sends as ${account.senderName} <${account.gmailAddress}>`
                      : `Sends as ${account.gmailAddress}`}
                  </span>

                  {account.sync && (
                    <span className="hint accounts__sync">
                      {account.sync.error
                        ? `Indexing stopped: ${account.sync.error}`
                        : account.sync.backfilling
                          ? // Gmail's own total is deliberately absent: it
                            // lags badly after a bulk deletion, and printing
                            // it beside Hive's count read as though the index
                            // still held every one of them.
                            `Indexed ${account.sync.indexed.toLocaleString()} so far`
                          : `Indexed ${account.sync.indexed.toLocaleString()} messages`}
                    </span>
                  )}
                </div>

                {/*
                  Status here, controls in Rules. This page is for connecting
                  and disconnecting; the index is background work and belongs
                  with the other background work.
                */}
                <button
                  type="button"
                  className="link icon-btn"
                  onClick={() => setPendingDisconnect(account)}
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

      {pendingDisconnect && (
        <ConfirmDialog
          title={`Disconnect ${pendingDisconnect.gmailAddress}?`}
          body="Hive stops reading this mailbox and forgets its tokens. Nothing in the mailbox itself changes, and you can connect it again at any time."
          confirmLabel="Disconnect"
          onCancel={() => setPendingDisconnect(null)}
          onConfirm={() => void disconnect(pendingDisconnect)}
        />
      )}
    </section>
  )
}

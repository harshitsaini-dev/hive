import { useState } from 'react'
import type { ConnectedAccount } from '@hive/shared-types'
import { api, ApiRequestError } from '../api.js'
import { ConfirmDialog } from '../ConfirmDialog.js'
import { AlertIcon, PlusIcon, TrashIcon } from '../Icons.js'
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
  /** The account awaiting confirmation before it is disconnected. */
  const [pendingDisconnect, setPendingDisconnect] =
    useState<ConnectedAccount | null>(null)
  /** The account whose sending name is being edited, if any. */
  const [naming, setNaming] = useState<string | null>(null)
  const [nameDraft, setNameDraft] = useState('')

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

  async function saveName() {
    const accountId = naming
    if (!accountId) return

    setNaming(null)
    setActionError(null)

    try {
      await api.setDisplayName(accountId, nameDraft)
      await onChanged()
    } catch (caught) {
      setActionError(
        caught instanceof ApiRequestError
          ? caught.message
          : 'Could not save that name.',
      )
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

        {!loading && accounts.length > 0 && (
          <ul className="accounts">
            {accounts.map((account) => (
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
                    {account.displayName
                      ? `Sends as ${account.displayName} <${account.gmailAddress}>`
                      : 'Sends under the name set in Gmail for this address'}
                  </span>

                  {account.sync && (
                    <span className="hint accounts__sync">
                      {account.sync.error
                        ? `Indexing stopped: ${account.sync.error}`
                        : account.sync.backfilling
                          ? `Indexing — ${account.sync.indexed.toLocaleString()}${
                              account.sync.estimate
                                ? ` of about ${account.sync.estimate.toLocaleString()}`
                                : ''
                            } so far`
                          : `Indexed ${account.sync.indexed.toLocaleString()} messages`}
                    </span>
                  )}
                </div>

                {/*
                  Status here, controls in Rules. This page is for connecting
                  and disconnecting; the index is background work and belongs
                  with the other background work.
                */}
                <div className="accounts__actions">
                  <button
                    type="button"
                    className="btn-quiet"
                    onClick={() => {
                      setNaming(account.id)
                      setNameDraft(account.displayName ?? '')
                    }}
                  >
                    {account.displayName ? 'Change name' : 'Set name'}
                  </button>
                </div>
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

      {naming && (
        <div
          className="modal-backdrop"
          onClick={(event) => {
            if (event.target === event.currentTarget) setNaming(null)
          }}
        >
          <div className="modal" role="dialog" aria-modal="true"
               aria-labelledby="name-title">
            <h2 id="name-title">Name on outgoing mail</h2>
            <p className="hint">
              Leave it empty to use whatever Gmail has set for this address.
            </p>

            <label htmlFor="sender-name">Display name</label>
            <input
              id="sender-name"
              autoFocus
              value={nameDraft}
              placeholder="Harshit"
              onChange={(event) => setNameDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void saveName()
              }}
            />

            <div className="modal__actions">
              <button
                type="button"
                className="link"
                onClick={() => setNaming(null)}
              >
                Cancel
              </button>
              <button type="button" onClick={() => void saveName()}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}

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

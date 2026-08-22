import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ConnectedAccount } from '@hive/shared-types'
import { api, ApiRequestError, type MessageRow } from './api.js'
import { ConfirmDestructive } from './ConfirmDestructive.js'
import { AlertIcon, SearchIcon, TrashIcon } from './Icons.js'

type View = 'inbox' | 'trash'

interface Load {
  loading: boolean
  messages: MessageRow[]
  error: string | null
  /** Per-account failures — one broken account must not hide the others. */
  problems: { gmailAddress: string; reason: string }[]
}

const EMPTY: Load = { loading: true, messages: [], error: null, problems: [] }

function formatDate(iso: string): string {
  const date = new Date(iso)
  const daysAgo = (Date.now() - date.getTime()) / 86_400_000

  // Recent mail is easier to place by time of day than by date.
  return daysAgo < 1
    ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/** `"Someone <a@b.com>"` reads better as just the display name. */
function senderName(from: string): string {
  const match = /^\s*"?([^"<]+?)"?\s*</.exec(from)
  return match?.[1]?.trim() || from.replace(/[<>]/g, '')
}

export function MailboxPage({ accounts }: { accounts: ConnectedAccount[] }) {
  const [view, setView] = useState<View>('inbox')
  const [accountId, setAccountId] = useState<string>('')
  const [search, setSearch] = useState('')
  const [applied, setApplied] = useState('')
  const [load, setLoad] = useState<Load>(EMPTY)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [pending, setPending] = useState<'trash' | 'restore' | 'delete' | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  // The Trash view is just a different Gmail query; there is no second index.
  const query = useMemo(
    () => [view === 'trash' ? 'in:trash' : '-in:trash', applied].filter(Boolean).join(' '),
    [view, applied],
  )

  const refresh = useCallback(async () => {
    setLoad((previous) => ({ ...previous, loading: true, error: null }))
    setSelected(new Set())

    try {
      const result = await api.searchMessages({ q: query, accountId: accountId || undefined })

      setLoad({
        loading: false,
        messages: result.messages,
        error: null,
        problems: [
          ...result.accounts
            .filter((entry) => entry.error)
            .map((entry) => ({ gmailAddress: entry.gmailAddress, reason: entry.error! })),
          ...result.skipped.map((entry) => ({
            gmailAddress: entry.gmailAddress,
            reason: 'needs reconnecting',
          })),
        ],
      })
    } catch (caught) {
      setLoad({
        loading: false,
        messages: [],
        problems: [],
        error:
          caught instanceof ApiRequestError ? caught.message : 'Could not search.',
      })
    }
  }, [query, accountId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const selectedRows = load.messages.filter((message) =>
    selected.has(message.gmailMessageId),
  )

  /**
   * Bulk actions are grouped by account: message IDs are only meaningful
   * against the mailbox they came from, and a merged view mixes them.
   */
  const byAccount = () => {
    const groups = new Map<string, string[]>()
    for (const row of selectedRows) {
      const ids = groups.get(row.accountId) ?? []
      ids.push(row.gmailMessageId)
      groups.set(row.accountId, ids)
    }
    return [...groups]
  }

  async function run(
    action: 'trash' | 'restore' | 'delete',
    verb: string,
  ): Promise<void> {
    setPending(action)
    setNotice(null)

    try {
      let total = 0
      for (const [id, messageIds] of byAccount()) {
        if (action === 'trash') await api.trashMessages(id, messageIds)
        else if (action === 'restore') await api.restoreMessages(id, messageIds)
        else await api.deleteForever(id, messageIds)
        total += messageIds.length
      }

      setNotice(`${verb} ${total} message${total === 1 ? '' : 's'}.`)
      await refresh()
    } catch (caught) {
      setNotice(
        caught instanceof ApiRequestError ? caught.message : `Could not ${action}.`,
      )
    } finally {
      setPending(null)
      setConfirming(false)
    }
  }

  const allSelected =
    load.messages.length > 0 && selected.size === load.messages.length

  return (
    <section className="mailbox">
      <div className="mailbox__tabs" role="tablist" aria-label="Mailbox">
        {(['inbox', 'trash'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={view === tab}
            className={`tab${view === tab ? ' tab--active' : ''}`}
            onClick={() => {
              setView(tab)
              setSelected(new Set())
            }}
          >
            {tab === 'inbox' ? 'Inbox' : 'Trash'}
          </button>
        ))}
      </div>

      <form
        className="mailbox__search"
        onSubmit={(event) => {
          event.preventDefault()
          setApplied(search.trim())
        }}
      >
        <label htmlFor="q" className="sr-only">
          Search mail
        </label>
        <div className="search-field">
          <SearchIcon size={16} />
          <input
            id="q"
            type="search"
            value={search}
            placeholder="from:someone older_than:30d has:attachment"
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>

        <label htmlFor="account" className="sr-only">
          Account
        </label>
        <select
          id="account"
          value={accountId}
          onChange={(event) => setAccountId(event.target.value)}
        >
          <option value="">All accounts</option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.gmailAddress}
            </option>
          ))}
        </select>

        <button type="submit">Search</button>
      </form>

      {/* Gmail's own syntax, so anyone who uses Gmail already knows it. */}
      <p className="hint mailbox__syntax">
        Gmail search syntax works here — <code>from:</code>, <code>subject:</code>,{' '}
        <code>older_than:30d</code>, <code>has:attachment</code>,{' '}
        <code>is:unread</code>.
      </p>

      <div role="status" aria-live="polite">
        {notice && <p className="notice">{notice}</p>}
      </div>

      {load.problems.length > 0 && (
        <ul className="mailbox__problems">
          {load.problems.map((problem) => (
            <li key={problem.gmailAddress}>
              <AlertIcon size={14} />
              {problem.gmailAddress} — {problem.reason}
            </li>
          ))}
        </ul>
      )}

      {selected.size > 0 && (
        <div className="bulkbar">
          <span>
            {selected.size} selected
            {selectedRows.length !== selected.size && ' on this page'}
          </span>

          <div className="bulkbar__actions">
            {view === 'inbox' ? (
              <button
                type="button"
                className="icon-btn"
                disabled={pending !== null}
                onClick={() => void run('trash', 'Moved to Trash:')}
              >
                <TrashIcon size={15} />
                {pending === 'trash' ? 'Moving…' : 'Move to Trash'}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="btn-outline"
                  disabled={pending !== null}
                  onClick={() => void run('restore', 'Restored')}
                >
                  {pending === 'restore' ? 'Restoring…' : 'Restore'}
                </button>

                {/*
                  Permanent deletion is never a one-click action: it opens a
                  type-to-confirm dialog. There is no undo (ADR 0002).
                */}
                <button
                  type="button"
                  className="btn-danger icon-btn"
                  disabled={pending !== null}
                  onClick={() => setConfirming(true)}
                >
                  <TrashIcon size={15} />
                  Delete forever
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {load.loading && <p className="hint">Searching…</p>}
      {load.error && <p className="bad">{load.error}</p>}

      {!load.loading && !load.error && load.messages.length === 0 && (
        <p className="hint">
          {view === 'trash'
            ? 'Trash is empty.'
            : applied
              ? 'Nothing matched that search.'
              : 'No mail here.'}
        </p>
      )}

      {load.messages.length > 0 && (
        <>
          <label className="selectall">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={(event) =>
                setSelected(
                  event.target.checked
                    ? new Set(load.messages.map((m) => m.gmailMessageId))
                    : new Set(),
                )
              }
            />
            Select all {load.messages.length} on this page
          </label>

          <ul className="messages">
            {load.messages.map((message) => (
              <li key={`${message.accountId}:${message.gmailMessageId}`}>
                <label className="message">
                  <input
                    type="checkbox"
                    checked={selected.has(message.gmailMessageId)}
                    onChange={(event) => {
                      const next = new Set(selected)
                      if (event.target.checked) next.add(message.gmailMessageId)
                      else next.delete(message.gmailMessageId)
                      setSelected(next)
                    }}
                  />

                  <span className="message__body">
                    <span className="message__top">
                      <strong>{senderName(message.from)}</strong>
                      <span className="message__date">
                        {formatDate(message.receivedAt)}
                      </span>
                    </span>
                    <span className="message__subject">
                      {message.subject || '(no subject)'}
                    </span>
                    <span className="message__snippet">{message.snippet}</span>
                    {accounts.length > 1 && (
                      <span className="message__account">
                        {message.gmailAddress}
                      </span>
                    )}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </>
      )}

      {confirming && (
        <ConfirmDestructive
          count={selected.size}
          busy={pending === 'delete'}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void run('delete', 'Permanently deleted')}
        />
      )}
    </section>
  )
}

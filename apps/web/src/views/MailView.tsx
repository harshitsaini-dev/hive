import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ConnectedAccount } from '@hive/shared-types'
import { api, ApiRequestError, type MessageRow } from '../api.js'
import { ConfirmDestructive } from '../ConfirmDestructive.js'
import { AlertIcon, MailIcon, SearchIcon, TrashIcon } from '../Icons.js'
import { MessageListSkeleton } from '../Skeleton.js'

interface Load {
  loading: boolean
  messages: MessageRow[]
  error: string | null
  /** Per-account failures — one broken mailbox must not hide the others. */
  problems: { gmailAddress: string; reason: string }[]
}

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

export function MailView({
  accounts,
  loading: accountsLoading,
  mode,
}: {
  accounts: ConnectedAccount[]
  loading: boolean
  mode: 'inbox' | 'trash'
}) {
  const [accountId, setAccountId] = useState('')
  const [search, setSearch] = useState('')
  const [applied, setApplied] = useState('')
  const [load, setLoad] = useState<Load>({
    loading: true,
    messages: [],
    error: null,
    problems: [],
  })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [pending, setPending] = useState<'trash' | 'restore' | 'delete' | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [resolving, setResolving] = useState(false)
  /** Set when the selection covers the whole query, not just this page. */
  const [wholeQuery, setWholeQuery] = useState<{
    rows: { accountId: string; gmailMessageId: string }[]
    truncated: boolean
    limit: number
  } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // Trash is just a different Gmail query; there is no second index.
  const query = useMemo(
    () =>
      [mode === 'trash' ? 'in:trash' : '-in:trash', applied]
        .filter(Boolean)
        .join(' '),
    [mode, applied],
  )

  const refresh = useCallback(async () => {
    if (accountsLoading) return

    setLoad((previous) => ({ ...previous, loading: true, error: null }))
    setSelected(new Set())
    setWholeQuery(null)

    try {
      const result = await api.searchMessages({
        q: query,
        accountId: accountId || undefined,
      })

      setLoad({
        loading: false,
        messages: result.messages,
        error: null,
        problems: [
          ...result.accounts
            .filter((entry) => entry.error)
            .map((entry) => ({
              gmailAddress: entry.gmailAddress,
              reason: entry.error!,
            })),
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
  }, [query, accountId, accountsLoading])

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
  const groupByAccount = (rows: { accountId: string; gmailMessageId: string }[]) => {
    const groups = new Map<string, string[]>()
    for (const row of rows) {
      const ids = groups.get(row.accountId) ?? []
      ids.push(row.gmailMessageId)
      groups.set(row.accountId, ids)
    }
    return [...groups]
  }

  /**
   * Expands the selection from this page to everything the search matches.
   *
   * The whole point of the product is clearing thousands at once, and a page
   * holds twenty-five. Rather than paging through and ticking boxes, the
   * server resolves the query to a real ID list and a real count — which is
   * also what lets the confirmation state a number instead of a guess.
   */
  async function selectWholeQuery() {
    setResolving(true)
    setNotice(null)

    try {
      const targets = accountId
        ? accounts.filter((account) => account.id === accountId)
        : accounts

      const resolved = await Promise.all(
        targets.map(async (account) => ({
          accountId: account.id,
          ...(await api.resolveQuery(account.id, query)),
        })),
      )

      const rows = resolved.flatMap((result) =>
        result.messageIds.map((id) => ({
          accountId: result.accountId,
          gmailMessageId: id,
        })),
      )

      setWholeQuery({
        rows,
        // True when any account hit the server's per-action cap. Surfaced
        // rather than swallowed: otherwise the user believes an action covered
        // everything when it covered the first 5,000.
        truncated: resolved.some((result) => result.truncated),
        limit: resolved[0]?.limit ?? 0,
      })
    } catch (caught) {
      setNotice(
        caught instanceof ApiRequestError
          ? caught.message
          : 'Could not work out how many messages match.',
      )
    } finally {
      setResolving(false)
    }
  }

  /** What a bulk action will actually touch. */
  const targetRows = wholeQuery ? wholeQuery.rows : selectedRows
  const targetCount = targetRows.length

  async function run(action: 'trash' | 'restore' | 'delete', verb: string) {
    setPending(action)
    setNotice(null)

    try {
      let total = 0
      for (const [id, messageIds] of groupByAccount(targetRows)) {
        if (action === 'trash') await api.trashMessages(id, messageIds)
        else if (action === 'restore') await api.restoreMessages(id, messageIds)
        else await api.deleteForever(id, messageIds)
        total += messageIds.length
      }

      setNotice(`${verb} ${total} message${total === 1 ? '' : 's'}.`)
      setWholeQuery(null)
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

  const busy = accountsLoading || load.loading
  const allSelected =
    load.messages.length > 0 && selected.size === load.messages.length

  return (
    <section className="view">
      <header className="view__head">
        <h1>
          {mode === 'trash' ? <TrashIcon size={20} /> : <MailIcon size={20} />}
          {mode === 'trash' ? 'Trash' : 'Inbox'}
        </h1>
        {mode === 'trash' && (
          <p className="hint">
            Gmail empties this automatically after thirty days.
          </p>
        )}
      </header>

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

        {accounts.length > 1 && (
          <>
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
          </>
        )}

        <button type="submit">Search</button>
      </form>

      <p className="hint mailbox__syntax">
        Gmail search syntax works here — <code>from:</code>, <code>subject:</code>,{' '}
        <code>older_than:30d</code>, <code>has:attachment</code>,{' '}
        <code>is:unread</code>.
      </p>

      <div role="status" aria-live="polite">
        {notice && <p className="notice">{notice}</p>}
        {busy && <span className="sr-only">Loading messages</span>}
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
          <div className="bulkbar__count">
            <span>
              {wholeQuery
                ? `${targetCount} selected — everything matching this search`
                : `${selected.size} selected on this page`}
            </span>

            {/*
              The escape hatch from "this page" to "the whole search". Offered
              only once the page is fully ticked, which is the moment someone
              is obviously trying to select more than they can see.
            */}
            {!wholeQuery && allSelected && (
              <button
                type="button"
                className="link"
                disabled={resolving || pending !== null}
                onClick={() => void selectWholeQuery()}
              >
                {resolving ? 'Counting…' : 'Select everything matching this search'}
              </button>
            )}

            {wholeQuery && (
              <button
                type="button"
                className="link"
                disabled={pending !== null}
                onClick={() => setWholeQuery(null)}
              >
                Just this page instead
              </button>
            )}
          </div>

          <div className="bulkbar__actions">
            {mode === 'inbox' ? (
              <button
                type="button"
                className="icon-btn"
                disabled={pending !== null}
                onClick={() => void run('trash', 'Moved to Trash:')}
              >
                <TrashIcon size={15} />
                {pending === 'trash'
                  ? 'Moving…'
                  : `Move ${targetCount} to Trash`}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="btn-outline"
                  disabled={pending !== null}
                  onClick={() => void run('restore', 'Restored')}
                >
                  {pending === 'restore' ? 'Restoring…' : `Restore ${targetCount}`}
                </button>

                {/* Never one click: opens a type-to-confirm dialog (ADR 0002). */}
                <button
                  type="button"
                  className="btn-danger icon-btn"
                  disabled={pending !== null}
                  onClick={() => setConfirming(true)}
                >
                  <TrashIcon size={15} />
                  Delete {targetCount} forever
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {wholeQuery?.truncated && (
        <p className="mailbox__truncated">
          <AlertIcon size={15} />
          This search matches more than {wholeQuery.limit.toLocaleString()}{' '}
          messages. Only the first {wholeQuery.limit.toLocaleString()} are
          selected — run the action again afterwards to continue.
        </p>
      )}

      {busy && <MessageListSkeleton />}

      {!busy && load.error && <p className="bad">{load.error}</p>}

      {!busy && !load.error && load.messages.length === 0 && (
        <p className="hint">
          {mode === 'trash'
            ? 'Trash is empty.'
            : applied
              ? 'Nothing matched that search.'
              : 'No mail here.'}
        </p>
      )}

      {!busy && load.messages.length > 0 && (
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
          count={targetCount}
          busy={pending === 'delete'}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void run('delete', 'Permanently deleted')}
        />
      )}
    </section>
  )
}

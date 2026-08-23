import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ConnectedAccount } from '@hive/shared-types'
import { api, ApiRequestError, type MessageRow } from '../api.js'
import { ConfirmDestructive } from '../ConfirmDestructive.js'
import { AlertIcon, MailIcon, TrashIcon } from '../Icons.js'
import {
  buildQuery,
  EMPTY_FILTERS,
  hasAnyFilter,
  MailFilters,
  type Filters,
} from '../MailFilters.js'
import { MessageReader } from '../MessageReader.js'
import { MessageListSkeleton } from '../Skeleton.js'

/**
 * A full page is large on purpose: the product exists to work through
 * thousands, and paging twenty-five at a time makes that miserable. Every
 * message costs a separate metadata fetch though, so a page of 500 takes a
 * few seconds — the server limits concurrency to stay inside Gmail's rate
 * limit rather than collecting 429s.
 */
const PAGE_SIZE = 500

interface Load {
  loading: boolean
  messages: MessageRow[]
  error: string | null
  nextPageToken: string | null
  /** Per-account failures — one broken mailbox must not hide the others. */
  problems: { gmailAddress: string; reason: string }[]
}

const EMPTY_LOAD: Load = {
  loading: true,
  messages: [],
  error: null,
  nextPageToken: null,
  problems: [],
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
  initialFilters,
}: {
  accounts: ConnectedAccount[]
  loading: boolean
  mode: 'inbox' | 'sent' | 'trash'
  /** Pre-applied filters, e.g. from the command palette. */
  initialFilters?: Filters
}) {
  const [accountId, setAccountId] = useState('')
  const [filters, setFilters] = useState<Filters>(initialFilters ?? EMPTY_FILTERS)
  const [applied, setApplied] = useState<Filters>(initialFilters ?? EMPTY_FILTERS)
  const [load, setLoad] = useState<Load>(EMPTY_LOAD)
  const [loadingMore, setLoadingMore] = useState(false)
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
  /** The message open in the reading pane, if any. */
  const [reading, setReading] = useState<{
    accountId: string
    messageId: string
  } | null>(null)

  /*
   * Each view is a Gmail query; there is no second index.
   *
   * Inbox is `in:inbox`, not `-in:trash`. Those look equivalent and are not:
   * the latter matches everything outside the bin, so sent mail, drafts and
   * spam all showed up in the inbox together.
   */
  const scope =
    mode === 'trash' ? 'in:trash' : mode === 'sent' ? 'in:sent' : 'in:inbox'

  const query = useMemo(
    () => [scope, buildQuery(applied)].filter(Boolean).join(' '),
    [scope, applied],
  )

  const refresh = useCallback(async () => {
    if (accountsLoading) return

    setLoad((previous) => ({ ...previous, loading: true, error: null }))
    setSelected(new Set())
    setWholeQuery(null)
    setReading(null)

    try {
      const result = await api.searchMessages({
        q: query,
        accountId: accountId || undefined,
        pageSize: PAGE_SIZE,
      })

      setLoad({
        loading: false,
        messages: result.messages,
        nextPageToken: result.nextPageToken,
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
        ...EMPTY_LOAD,
        loading: false,
        error:
          caught instanceof ApiRequestError ? caught.message : 'Could not search.',
      })
    }
  }, [query, accountId, accountsLoading])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /** Appends the next page rather than replacing — selections survive. */
  async function loadMore() {
    if (!load.nextPageToken) return

    setLoadingMore(true)
    try {
      const result = await api.searchMessages({
        q: query,
        accountId: accountId || undefined,
        pageSize: PAGE_SIZE,
        pageToken: load.nextPageToken,
      })

      setLoad((previous) => ({
        ...previous,
        messages: [...previous.messages, ...result.messages],
        nextPageToken: result.nextPageToken,
      }))
    } catch (caught) {
      setNotice(
        caught instanceof ApiRequestError
          ? caught.message
          : 'Could not load more messages.',
      )
    } finally {
      setLoadingMore(false)
    }
  }

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
   * Expands the selection from the loaded pages to everything the search
   * matches. The server resolves the query to a real ID list and a real count,
   * which is what lets the confirmation state a number instead of a guess.
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

      setWholeQuery({
        rows: resolved.flatMap((result) =>
          result.messageIds.map((id) => ({
            accountId: result.accountId,
            gmailMessageId: id,
          })),
        ),
        // True when any account hit the server's per-action cap. Surfaced
        // rather than swallowed: otherwise the user believes an action covered
        // everything when it covered the first few thousand.
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
    <section className={reading ? 'view view--split' : 'view'}>
      <header className="view__head">
        <h1>
          {mode === 'trash' ? <TrashIcon size={20} /> : <MailIcon size={20} />}
          {mode === 'trash' ? 'Trash' : mode === 'sent' ? 'Sent' : 'Inbox'}
        </h1>
        {mode === 'trash' && (
          <p className="hint">
            Gmail empties this automatically after thirty days.
          </p>
        )}
      </header>

      {/* List on the left, reading pane on the right when one is open. */}
      <div className="view__panes">
        <div className="view__list">

      <div className="filters__wrap">
        <MailFilters
          filters={filters}
          onChange={setFilters}
          onApply={() => setApplied(filters)}
          onClear={() => {
            setFilters(EMPTY_FILTERS)
            setApplied(EMPTY_FILTERS)
          }}
        />

        {accounts.length > 1 && (
          <div className="filters__row">
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
          </div>
        )}
      </div>

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
                : `${selected.size} selected`}
            </span>

            {/*
              The escape hatch from "what is loaded" to "the whole search",
              offered once everything on screen is ticked — the moment someone
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
                Just what is loaded instead
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
                {pending === 'trash' ? 'Moving…' : `Move ${targetCount} to Trash`}
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

      {busy && <MessageListSkeleton rows={8} />}

      {!busy && load.error && <p className="bad">{load.error}</p>}

      {!busy && !load.error && load.messages.length === 0 && (
        <p className="hint">
          {mode === 'trash'
            ? 'Trash is empty.'
            : hasAnyFilter(applied)
              ? 'Nothing matched those filters.'
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
            Select all {load.messages.length.toLocaleString()} loaded
          </label>

          <ul className="messages">
            {load.messages.map((message) => {
              const isOpen =
                reading?.messageId === message.gmailMessageId &&
                reading.accountId === message.accountId

              return (
                <li key={`${message.accountId}:${message.gmailMessageId}`}>
                  <div className="message" data-open={isOpen}>
                    {/*
                      The checkbox and the row are separate targets. A single
                      label wrapping both would mean every attempt to open a
                      message toggled its checkbox instead.
                    */}
                    <input
                      type="checkbox"
                      aria-label={`Select ${message.subject || 'message'}`}
                      checked={selected.has(message.gmailMessageId)}
                      onChange={(event) => {
                        const next = new Set(selected)
                        if (event.target.checked) next.add(message.gmailMessageId)
                        else next.delete(message.gmailMessageId)
                        setSelected(next)
                      }}
                    />

                    <button
                      type="button"
                      className="message__open"
                      aria-expanded={isOpen}
                      onClick={() =>
                        setReading(
                          isOpen
                            ? null
                            : {
                                accountId: message.accountId,
                                messageId: message.gmailMessageId,
                              },
                        )
                      }
                    >
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
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>

          {load.nextPageToken && (
            <div className="loadmore">
              <button
                type="button"
                className="btn-outline"
                disabled={loadingMore}
                onClick={() => void loadMore()}
              >
                {loadingMore ? 'Loading…' : `Load ${PAGE_SIZE} more`}
              </button>
            </div>
          )}
        </>
      )}

        </div>

        {reading && (
          <MessageReader
            key={`${reading.accountId}:${reading.messageId}`}
            accountId={reading.accountId}
            messageId={reading.messageId}
            onClose={() => setReading(null)}
          />
        )}
      </div>

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

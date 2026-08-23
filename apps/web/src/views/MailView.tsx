import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ConnectedAccount } from '@hive/shared-types'
import { api, ApiRequestError, type MessageRow } from '../api.js'
import { ConfirmDestructive } from '../ConfirmDestructive.js'
import { AlertIcon, MailIcon, SearchIcon, TrashIcon } from '../Icons.js'
import {
  buildQuery,
  EMPTY_FILTERS,
  hasAnyFilter,
  MailFilters,
  type Filters,
} from '../MailFilters.js'
import { MessageReader } from '../MessageReader.js'
import { Select } from '../Select.js'
import { MessageListSkeleton } from '../Skeleton.js'

/**
 * A full page is large on purpose: the product exists to work through
 * thousands, and paging twenty-five at a time makes that miserable. Every
 * message costs a separate metadata fetch though, so a page of 500 takes a
 * few seconds — the server limits concurrency to stay inside Gmail's rate
 * limit rather than collecting 429s.
 */
const PAGE_SIZE = 500

/*
 * How many messages the view will page in by itself before it stops and asks.
 *
 * A filter is a question about the whole mailbox, not about the page you can
 * see, so the pages that follow are fetched without being asked for. They are
 * not free though — every message costs a metadata fetch, so a hundred
 * thousand of them would grind for an hour. Ten thousand matches the bulk cap,
 * and past it the button comes back.
 */
const AUTO_LOAD_MAX = 10_000

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
  everywhere = false,
}: {
  accounts: ConnectedAccount[]
  loading: boolean
  mode: 'inbox' | 'sent' | 'trash'
  /** Pre-applied filters, e.g. from the command palette. */
  initialFilters?: Filters
  /**
   * Search the whole mailbox rather than one folder. Set when the search came
   * from the command palette, which showed results from everywhere — landing
   * in an `in:inbox` view would silently drop most of what it just listed.
   */
  everywhere?: boolean
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
  /** Opt back into the folder when a search should not leave it. */
  const [folderOnly, setFolderOnly] = useState(false)
  /** Paused by the user, or by hitting the ceiling. */
  const [paused, setPaused] = useState(false)
  /** True once the view has paged past the first response. */
  const [paged, setPaged] = useState(false)
  /**
   * How many messages the query matches in total, resolved separately from the
   * pages themselves. Message ids come back 500 at a time and cost nothing to
   * fetch, so the real total is cheap even when the metadata behind it is not.
   */
  const [total, setTotal] = useState<{ count: number; truncated: boolean } | null>(
    null,
  )
  /** Set when the selection covers the whole query, not just this page. */
  const [wholeQuery, setWholeQuery] = useState<{
    rows: { accountId: string; gmailMessageId: string }[]
    truncated: boolean
    limit: number
  } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /** Live progress for a background bulk action. */
  const [progress, setProgress] = useState<{
    processed: number
    total: number
  } | null>(null)
  /** The message open in the reading pane, if any. */
  const [reading, setReading] = useState<{
    accountId: string
    messageId: string
  } | null>(null)

  /*
   * Each view is a Gmail query; there is no second index.
   *
   * Browsing a folder is `in:inbox`, not `-in:trash`. Those look equivalent
   * and are not: the latter matches everything outside the bin, so sent mail,
   * drafts and spam all showed up in the inbox together.
   *
   * Searching is different from browsing. A search for a word plus an
   * attachment found nothing while the mail plainly existed, because it had
   * been archived — archived mail is not `in:inbox`, and scoping a search to
   * the folder you happened to be standing in hides most of the mailbox. So
   * the moment any filter is applied the folder scope drops, the same way
   * Gmail's own search does. Spam is the one thing still excluded, and the
   * Trash view keeps its scope because the bin *is* the subject there.
   */
  const searching = hasAnyFilter(applied)
  const spansAll =
    !folderOnly && (everywhere || (searching && mode !== 'trash'))

  const scope = spansAll
    ? '-in:spam'
    : mode === 'trash'
      ? 'in:trash'
      : mode === 'sent'
        ? 'in:sent'
        : 'in:inbox'

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
    setPaused(false)
    setPaged(false)
    setTotal(null)

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
  const loadMore = useCallback(async () => {
    if (!load.nextPageToken) return

    setLoadingMore(true)
    try {
      const result = await api.searchMessages({
        q: query,
        accountId: accountId || undefined,
        pageSize: PAGE_SIZE,
        pageToken: load.nextPageToken,
      })

      setPaged(true)
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
  }, [load.nextPageToken, query, accountId])

  /*
   * Keeps paging on its own until the search is exhausted.
   *
   * A filter asks a question about the mailbox; making someone click "load
   * more" to finish answering it turns one page of results into the answer,
   * which is exactly how a search that had matched everything looked like a
   * search that had matched nothing. The pause below is the escape hatch, and
   * the count beside it means nobody has to guess how far there is to go.
   */
  useEffect(() => {
    if (paused || loadingMore || load.loading || !load.nextPageToken) return
    if (load.messages.length >= AUTO_LOAD_MAX) {
      setPaused(true)
      return
    }
    void loadMore()
  }, [
    paused,
    loadingMore,
    load.loading,
    load.nextPageToken,
    load.messages.length,
    loadMore,
  ])

  /*
   * The real total, fetched alongside the pages rather than after them. Only
   * worth asking for when there is a second page — otherwise what is on screen
   * already is the answer.
   */
  useEffect(() => {
    if (load.loading || !load.nextPageToken || total) return

    let cancelled = false
    const targets = accountId
      ? accounts.filter((account) => account.id === accountId)
      : accounts

    void Promise.all(
      targets.map((account) => api.resolveQuery(account.id, query)),
    )
      .then((results) => {
        if (cancelled) return
        setTotal({
          count: results.reduce((sum, result) => sum + result.count, 0),
          truncated: results.some((result) => result.truncated),
        })
      })
      // A missing total is a missing label, not a broken view.
      .catch(() => undefined)

    return () => {
      cancelled = true
    }
  }, [load.loading, load.nextPageToken, total, query, accountId, accounts])

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

  /**
   * Polls a background job until it stops running.
   *
   * Polling rather than a socket: Vercel proxies `/api` to Render and does not
   * carry WebSocket upgrades, so a socket would have to be cross-origin — and
   * a `SameSite=Lax` session cookie does not go with one. See the note in
   * apps/server/src/jobs.ts.
   */
  async function watchJob(jobId: string, alreadyDone: number, total: number) {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 700))

      const job = await api.getJob(jobId)
      setProgress({ processed: alreadyDone + job.processed, total })

      if (job.status === 'failed') throw new Error(job.error ?? 'That did not finish.')
      if (job.status === 'done') return job.processed
    }
  }

  async function run(action: 'trash' | 'restore' | 'delete', verb: string) {
    setPending(action)
    setNotice(null)

    /*
     * Small selections stay synchronous. Below this, the work finishes faster
     * than the first poll would arrive, so a progress bar would flash rather
     * than inform.
     */
    const useJob = targetRows.length > 200
    if (useJob) setProgress({ processed: 0, total: targetRows.length })

    try {
      let total = 0

      for (const [id, messageIds] of groupByAccount(targetRows)) {
        const call =
          action === 'trash'
            ? api.trashMessages
            : action === 'restore'
              ? api.restoreMessages
              : api.deleteForever

        const result = await call(id, messageIds, useJob)

        if (result.jobId) {
          await watchJob(result.jobId, total, targetRows.length)
        }

        total += messageIds.length
        if (useJob) setProgress({ processed: total, total: targetRows.length })
      }

      setNotice(`${verb} ${total} message${total === 1 ? '' : 's'}.`)
      setWholeQuery(null)
      await refresh()
    } catch (caught) {
      setNotice(
        caught instanceof ApiRequestError
          ? caught.message
          : caught instanceof Error
            ? caught.message
            : `Could not ${action}.`,
      )
    } finally {
      setPending(null)
      setConfirming(false)
      setProgress(null)
    }
  }

  const busy = accountsLoading || load.loading
  const allSelected =
    load.messages.length > 0 && selected.size === load.messages.length

  return (
    <section className={reading ? 'view view--mail view--split' : 'view view--mail'}>
      <header className="view__head">
        <h1>
          {spansAll ? (
            <SearchIcon size={20} />
          ) : mode === 'trash' ? (
            <TrashIcon size={20} />
          ) : (
            <MailIcon size={20} />
          )}
          {spansAll
            ? 'Search results'
            : mode === 'trash'
              ? 'Trash'
              : mode === 'sent'
                ? 'Sent'
                : 'Inbox'}
        </h1>

        {spansAll && (
          <p className="hint view__scope">
            Searching all mail — inbox, sent, archived and trash.
            {!everywhere && (
              <button
                type="button"
                className="btn-quiet"
                onClick={() => setFolderOnly(true)}
              >
                Only search {mode === 'sent' ? 'Sent' : 'Inbox'}
              </button>
            )}
          </p>
        )}

        {!spansAll && searching && mode !== 'trash' && (
          <p className="hint view__scope">
            Searching {mode === 'sent' ? 'Sent' : 'Inbox'} only — archived mail
            is not included.
            <button
              type="button"
              className="btn-quiet"
              onClick={() => setFolderOnly(false)}
            >
              Search everywhere
            </button>
          </p>
        )}

        {!spansAll && mode === 'trash' && (
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
            <Select
              id="account"
              label="Account"
              value={accountId}
              options={[
                { value: '', label: 'All accounts' },
                ...accounts.map((account) => ({
                  value: account.id,
                  label: account.gmailAddress,
                })),
              ]}
              onChange={setAccountId}
            />
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

      {(selected.size > 0 || wholeQuery) && (
        <div className="bulkbar">
          <div className="bulkbar__count">
            <span>
              {wholeQuery
                ? `${targetCount.toLocaleString()} selected — everything matching this search`
                : `${selected.size.toLocaleString()} selected on this page`}
            </span>

            {wholeQuery && (
              <button
                type="button"
                className="btn-quiet"
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

      {progress && (
        <div className="progress" role="status" aria-live="polite">
          <div className="progress__label">
            <span>Working through your selection…</span>
            <span>
              {progress.processed.toLocaleString()} of{' '}
              {progress.total.toLocaleString()}
            </span>
          </div>
          <div
            className="progress__track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-valuenow={progress.processed}
          >
            <div
              className="progress__bar"
              style={{
                width: `${Math.round((progress.processed / Math.max(progress.total, 1)) * 100)}%`,
              }}
            />
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
            : !searching
              ? 'No mail here.'
              : spansAll
                ? 'Nothing in any folder matched those filters.'
                : `Nothing in ${mode === 'sent' ? 'Sent' : 'Inbox'} matched — try searching all mail.`}
        </p>
      )}

      {!busy && load.messages.length > 0 && (
        <>
          {/*
            Two explicit choices rather than one ambiguous "select all".
            "Select all 1,264 loaded" read as "that is everything" when the
            mailbox held 1,323 — the loaded count is a floor, not a total, so
            it is no longer offered as the headline number.
          */}
          <div className="selectbar">
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
              Select page
              <span className="hint">
                ({load.messages.length.toLocaleString()} shown)
              </span>
            </label>

            <button
              type="button"
              className="btn-quiet"
              disabled={resolving || pending !== null}
              onClick={() => void selectWholeQuery()}
            >
              {resolving ? 'Counting…' : 'Select all matching'}
            </button>

            {/*
              Searches go to Gmail, not to what is on screen, so a term that
              appears only in message 9,000 still finds it. Worth saying,
              because a visible list of 500 implies otherwise.
            */}
            <span className="hint selectbar__note">
              {spansAll
                ? 'Results come from every folder of every account, however many there are.'
                : 'Searches cover the whole folder, not just what is loaded.'}
            </span>
          </div>

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
            <div className="loadmore" role="status" aria-live="polite">
              {!paused ? (
                <>
                  <span className="hint">
                    {total
                      ? `Loading the rest — ${load.messages.length.toLocaleString()} of ${total.count.toLocaleString()}${
                          total.truncated ? '+' : ''
                        }`
                      : `Loading the rest — ${load.messages.length.toLocaleString()} so far`}
                  </span>
                  <button
                    type="button"
                    className="btn-quiet"
                    onClick={() => setPaused(true)}
                  >
                    Stop here
                  </button>
                </>
              ) : (
                <>
                  <span className="hint">
                    {total
                      ? `Showing ${load.messages.length.toLocaleString()} of ${total.count.toLocaleString()}${
                          total.truncated ? '+' : ''
                        } matches`
                      : `Showing ${load.messages.length.toLocaleString()} so far`}
                  </span>
                  <button
                    type="button"
                    className="btn-outline"
                    disabled={loadingMore}
                    onClick={() => setPaused(false)}
                  >
                    {loadingMore ? 'Loading…' : 'Keep loading'}
                  </button>
                </>
              )}
            </div>
          )}

          {/*
            Everything is in, so say the number rather than leaving a list that
            simply stops. A count that ends is the difference between "that is
            all of them" and "that is all it bothered to fetch".
          */}
          {!load.nextPageToken && paged && (
            <p className="hint loadmore">
              All {load.messages.length.toLocaleString()} matches loaded.
            </p>
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

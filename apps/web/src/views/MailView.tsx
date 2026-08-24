import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ConnectedAccount } from '@hive/shared-types'
import { api, ApiRequestError, type MessageRow } from '../api.js'
import { ConfirmDestructive } from '../ConfirmDestructive.js'
import {
  AlertIcon,
  ChartIcon,
  DraftIcon,
  MailIcon,
  SearchIcon,
  SendIcon,
  TrashIcon,
} from '../Icons.js'
import {
  buildQuery,
  EMPTY_FILTERS,
  hasAnyFilter,
  MailFilters,
  toStructured,
  type Filters,
} from '../MailFilters.js'
import { AnalyticsPanel } from '../AnalyticsPanel.js'
import type { MailboxView } from '../AppShell.js'
import { MessageReader } from '../MessageReader.js'
import { Select } from '../Select.js'
import { MessageListSkeleton } from '../Skeleton.js'

/**
 * A hundred, not five hundred.
 *
 * Five hundred was chosen when the product was about bulk cleanup and every
 * page came from Gmail — fewer, bigger pages meant fewer round trips. Both
 * halves of that have changed: searches are answered from the local index and
 * come back with a real total, so the page is a window rather than the answer,
 * and a hundred rows renders and scrolls far better on a phone.
 */
const PAGE_SIZE = 100

interface Load {
  loading: boolean
  messages: MessageRow[]
  error: string | null
  nextPageToken: string | null
  /** Offset paging, when the local index answered instead of Gmail. */
  nextOffset: number | null
  /** The real number this page is a slice of, when it is known. */
  total: number | null
  /** Per-account failures — one broken mailbox must not hide the others. */
  problems: { gmailAddress: string; reason: string }[]
}

const EMPTY_LOAD: Load = {
  loading: true,
  messages: [],
  error: null,
  nextPageToken: null,
  nextOffset: null,
  total: null,
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

/**
 * Folders a search stays inside.
 *
 * Searching from the inbox should reach archived mail — that was a real bug
 * once. Searching from Drafts, Spam or Trash should not: in each the folder
 * *is* the question, and widening it would answer a different one.
 */
function pinnedFolder(mode: MailboxView): boolean {
  return mode === 'trash' || mode === 'spam' || mode === 'drafts'
}

const EMPTY: Record<MailboxView, string> = {
  inbox: 'No mail here.',
  sent: 'Nothing sent yet.',
  drafts: 'No drafts.',
  spam: 'Nothing in Spam.',
  trash: 'Trash is empty.',
}

const TITLES: Record<MailboxView, string> = {
  inbox: 'Inbox',
  sent: 'Sent',
  drafts: 'Drafts',
  spam: 'Spam',
  trash: 'Trash',
}

const ICONS: Record<MailboxView, typeof MailIcon> = {
  inbox: MailIcon,
  sent: SendIcon,
  drafts: DraftIcon,
  spam: AlertIcon,
  trash: TrashIcon,
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
  mode: MailboxView
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
  /** The analysis panel, which shares the pane with the reader. */
  const [analysing, setAnalysing] = useState(false)

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
    !folderOnly && (everywhere || (searching && !pinnedFolder(mode)))

  /*
   * `in:drafts` and `in:spam` are folders Gmail keeps out of everything else,
   * so an "all mail" search still excludes them — a draft you have not sent
   * and a message Gmail already judged are both answers to a different
   * question than "where is that email".
   */
  const FOLDER: Record<MailboxView, string> = {
    inbox: 'in:inbox',
    sent: 'in:sent',
    drafts: 'in:drafts',
    spam: 'in:spam',
    trash: 'in:trash',
  }

  const pinned = mode === 'trash' || mode === 'spam' || mode === 'drafts'
  const scope = spansAll ? '-in:spam' : FOLDER[mode]

  const query = useMemo(
    () => [scope, buildQuery(applied)].filter(Boolean).join(' '),
    [scope, applied],
  )

  /*
   * The same filters in the shape the local index understands, or null when
   * they cannot be answered locally. The server decides which it can honour
   * and falls back to Gmail silently — this only offers it the choice.
   */
  const structuredJson = useMemo(
    () =>
      JSON.stringify(
        toStructured(
          applied,
          spansAll ? 'all' : mode === 'trash' ? 'trash' : mode,
        ),
      ),
    [applied, spansAll, mode],
  )

  const refresh = useCallback(async () => {
    if (accountsLoading) return

    setLoad((previous) => ({ ...previous, loading: true, error: null }))
    setSelected(new Set())
    setWholeQuery(null)
    setReading(null)
    setPaged(false)
    setTotal(null)

    try {
      const result = await api.searchMessages({
        q: query,
        accountId: accountId || undefined,
        pageSize: PAGE_SIZE,
        structured: JSON.parse(structuredJson) ?? undefined,
      })

      setLoad({
        loading: false,
        messages: result.messages,
        nextPageToken: result.nextPageToken,
        nextOffset: result.nextOffset ?? null,
        total: result.total ?? null,
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
  }, [query, accountId, accountsLoading, structuredJson])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /** Appends the next page rather than replacing — selections survive. */
  const loadMore = useCallback(async () => {
    // Two ways to page, because there are two answerers. Gmail hands back a
    // cursor per mailbox; the index counts rows and takes an offset.
    if (load.nextPageToken === null && load.nextOffset === null) return

    setLoadingMore(true)
    try {
      const result = await api.searchMessages({
        q: query,
        accountId: accountId || undefined,
        pageSize: PAGE_SIZE,
        structured: JSON.parse(structuredJson) ?? undefined,
        ...(load.nextOffset !== null
          ? { offset: load.nextOffset }
          : { pageToken: load.nextPageToken ?? undefined }),
      })

      setPaged(true)
      setLoad((previous) => {
        /*
         * Deduped on append. A cursor that fails to advance — a mailbox that
         * hands back the token it was given — would otherwise replay its last
         * page underneath the first, and a list with the same messages twice
         * looks exactly like a filter that stopped being applied partway down.
         */
        const seen = new Set(
          previous.messages.map((m) => `${m.accountId}:${m.gmailMessageId}`),
        )
        const fresh = result.messages.filter(
          (m) => !seen.has(`${m.accountId}:${m.gmailMessageId}`),
        )

        return {
          ...previous,
          messages: [...previous.messages, ...fresh],
          // Nothing new means the cursor is going in circles; stop.
          nextPageToken: fresh.length === 0 ? null : result.nextPageToken,
          nextOffset: fresh.length === 0 ? null : (result.nextOffset ?? null),
          total: result.total ?? previous.total,
        }
      })
    } catch (caught) {
      setNotice(
        caught instanceof ApiRequestError
          ? caught.message
          : 'Could not load more messages.',
      )
    } finally {
      setLoadingMore(false)
    }
  }, [load.nextPageToken, load.nextOffset, query, accountId, structuredJson])

  /*
   * The real total, fetched alongside the pages rather than after them. Only
   * worth asking for when there is a second page — otherwise what is on screen
   * already is the answer.
   */
  useEffect(() => {
    // The index reports a real total with the page. Only Gmail-served
    // searches need the extra resolve, which is what this ever existed for.
    if (load.total !== null) return
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
  }, [load.loading, load.nextPageToken, load.total, total, query, accountId, accounts])

  /*
   * Selecting more than one thing, the way every file manager does.
   *
   * Ticking five hundred boxes one at a time is not a feature, and "select
   * page / select all" only covers the two extremes. What was missing is the
   * middle: a run of rows, or a few scattered ones.
   *
   *   - click              toggles that row
   *   - shift-click        selects the run from the last click to this one
   *   - drag across boxes  selects what the pointer passes over
   *   - Ctrl/Cmd+A         selects the page, and again clears it
   *
   * The anchor is the last row clicked without Shift, which is what makes a
   * range repeatable: shift-clicking twice from the same anchor replaces the
   * range rather than growing it.
   */
  const anchor = useRef<number | null>(null)
  const dragAdds = useRef(true)

  const idAt = (index: number) => load.messages[index]?.gmailMessageId

  /*
   * Every one of these updates through the setter rather than from `selected`
   * directly. A drag fires a handler per row crossed, faster than React
   * re-renders, so reading the state variable means each step builds on the
   * value from the render it was created in — and the last one silently wins.
   */
  function applyRange(from: number, to: number, add: boolean) {
    const [start, end] = from <= to ? [from, to] : [to, from]

    setSelected((current) => {
      const next = new Set(current)

      for (let i = start; i <= end; i++) {
        const id = idAt(i)
        if (!id) continue
        if (add) next.add(id)
        else next.delete(id)
      }

      return next
    })
  }

  function toggleOne(index: number) {
    const id = idAt(index)
    if (!id) return

    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    anchor.current = index
  }

  /**
   * Shift-click: the run from the last plain click to this one.
   *
   * The range takes the sense of the row it started from, so shift-clicking
   * inside a selected block clears the block rather than re-selecting what is
   * already selected. Without an anchor there is no run, so it is a plain
   * toggle.
   */
  function selectRangeTo(index: number) {
    const from = anchor.current
    if (from === null) {
      toggleOne(index)
      return
    }

    const anchorId = idAt(from)
    const [start, end] = from <= index ? [from, index] : [index, from]

    /*
     * Whether this range selects or clears is decided *inside* the setter,
     * from the state React is about to update — not from the `selected` this
     * handler closed over. Read from outside it was one render behind, and
     * the range came out inverted or one row short depending on how the last
     * click had landed.
     */
    setSelected((current) => {
      const add = anchorId ? current.has(anchorId) : true
      const next = new Set(current)

      for (let i = start; i <= end; i++) {
        const id = idAt(i)
        if (!id) continue
        if (add) next.add(id)
        else next.delete(id)
      }

      return next
    })
  }

  function beginDrag(index: number) {
    const id = idAt(index)
    if (!id) return

    // The drag paints the opposite of what the row it started on already is,
    // decided before the click that follows flips it.
    dragAdds.current = !selected.has(id)
    anchor.current = index
  }

  /** While the button is held, the pointer paints the same decision along. */
  function extendDrag(index: number) {
    if (anchor.current === null) return


    // A range from the anchor rather than one row at a time: a fast drag
    // skips enter events, and a range cannot miss what it skipped.
    applyRange(anchor.current, index, dragAdds.current)
  }

  /*
   * Ctrl/Cmd+A selects the page, and again clears it.
   *
   * Ignored while a text field has focus, where the browser's own "select all
   * the text I am typing" is obviously what was meant.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'a' || !(event.ctrlKey || event.metaKey)) {
        return
      }

      const target = event.target as HTMLElement | null
      const tag = target?.tagName.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) {
        return
      }

      event.preventDefault()

      /*
       * Three states, not two: this page, everything the search matches, then
       * nothing. Pressing it twice used to clear the selection, which is a
       * strange thing to ask for twice — the second press obviously means
       * "no, all of it", the way it does in a file manager showing a folder
       * that is only partly loaded.
       */
      const wholePage =
        load.messages.length > 0 && selected.size === load.messages.length

      if (wholeQuery) {
        setWholeQuery(null)
        setSelected(new Set())
        return
      }

      if (wholePage) {
        void selectWholeQuery()
        return
      }

      setSelected(new Set(load.messages.map((message) => message.gmailMessageId)))
    }

    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load.messages, selected, wholeQuery])

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
          ) : (
            (() => {
              const Icon = ICONS[mode]
              return <Icon size={20} />
            })()
          )}
          {spansAll ? 'Search results' : TITLES[mode]}
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
                Only search {TITLES[mode]}
              </button>
            )}
          </p>
        )}

        {!spansAll && searching && mode !== 'trash' && (
          <p className="hint view__scope">
            Searching {TITLES[mode]} only — archived mail is not included.
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

        {!spansAll && mode === 'spam' && (
          <p className="hint">
            Gmail put these here. It empties Spam automatically after thirty
            days, so there is usually nothing to do.
          </p>
        )}

        {!spansAll && mode === 'drafts' && (
          <p className="hint">
            Messages you started and have not sent. Hive cannot edit a draft
            yet — open one to read it, or clear it out from here.
          </p>
        )}

        {/*
          Lives in the header rather than the pane it opens, because the pane
          is empty until something asks for it — an entry point you can only
          reach from the thing it opens is not an entry point.
        */}
        <button
          type="button"
          className="btn-quiet view__analyse"
          aria-pressed={analysing}
          onClick={() => {
            setAnalysing(!analysing)
            if (!analysing) setReading(null)
          }}
        >
          <ChartIcon size={15} />
          {analysing ? 'Hide analysis' : 'Analyse mailbox'}
        </button>
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
            {/*
              Branching on Trash, not on Inbox.
              It read `mode === 'inbox'`, which was harmless while Inbox and
              Trash were the only two lists — and the moment Sent, Drafts and
              Spam existed it offered *permanent deletion* in all three. ADR
              0002 puts that behind one type-to-confirm dialog in one place;
              this is that place, and nowhere else.
            */}
            {mode !== 'trash' ? (
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
          {pinnedFolder(mode)
            ? EMPTY[mode]
            : !searching
              ? 'No mail here.'
              : spansAll
                ? 'Nothing in any folder matched those filters.'
                : `Nothing in ${TITLES[mode]} matched — try searching all mail.`}
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
                ({load.messages.length.toLocaleString()} shown
                {load.total !== null && load.total > load.messages.length
                  ? ` of ${load.total.toLocaleString()}`
                  : ''}
                )
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
            <span className="hint selectbar__hint">
              Shift-click for a range, drag across the boxes, Ctrl+A for the
              page.
            </span>

            <span className="hint selectbar__note">
              {spansAll
                ? 'Results come from every folder of every account, however many there are.'
                : 'Searches cover the whole folder, not just what is loaded.'}
            </span>
          </div>

          <ul
            className="messages"
            /*
             * The drag reads the pointer, not `mouseenter`.
             *
             * Enter events are missable by design: a fast drag jumps whole
             * rows between frames and simply never enters them, and a
             * re-render mid-drag can move the element out from under the
             * pointer without firing anything at all. Asking what is under
             * the cursor cannot skip a row, because the range is taken from
             * the anchor rather than accumulated one crossing at a time.
             */
            onMouseMove={(event) => {
              if (event.buttons !== 1 || anchor.current === null) return

              const under = document
                .elementFromPoint(event.clientX, event.clientY)
                ?.closest('[data-row]')
              const index = Number(under?.getAttribute('data-row'))

              if (Number.isInteger(index)) extendDrag(index)
            }}
          >
            {load.messages.map((message, index) => {
              const isOpen =
                reading?.messageId === message.gmailMessageId &&
                reading.accountId === message.accountId

              return (
                <li key={`${message.accountId}:${message.gmailMessageId}`}>
                  <div
                    className="message"
                    data-open={isOpen}
                    /*
                     * The row, not the box. A drag has to follow the pointer,
                     * and a 22px checkbox is a target a moving pointer skips
                     * straight past — dragging down the list selected the
                     * first two rows and stopped, because the third box was
                     * never entered.
                     */
                    data-row={index}
                  >
                    {/*
                      The checkbox and the row are separate targets. A single
                      label wrapping both would mean every attempt to open a
                      message toggled its checkbox instead.
                    */}
                    <input
                      type="checkbox"
                      aria-label={`Select ${message.subject || 'message'}`}
                      checked={selected.has(message.gmailMessageId)}
                      /*
                       * The browser never toggles this one; React does.
                       *
                       * A checkbox flips itself *before* the click handler
                       * runs, so `preventDefault` there reverts it — and
                       * React, seeing the same `checked` prop as last render,
                       * has no reason to touch the DOM. The row then showed
                       * the opposite of what the app believed, which is how
                       * every range came out exactly one row short.
                       *
                       * Handling mousedown and cancelling it outright keeps
                       * the DOM out of the argument entirely: `checked` is
                       * whatever state says, always.
                       */
                      readOnly
                      onMouseDown={(event) => {
                        event.preventDefault()

                        if (event.shiftKey) {
                          selectRangeTo(index)
                          return
                        }

                        beginDrag(index)
                        toggleOne(index)
                      }}
                      /* Space and Enter still work; there is no mouse there. */
                      onKeyDown={(event) => {
                        if (event.key !== ' ' && event.key !== 'Enter') return
                        event.preventDefault()

                        if (event.shiftKey) selectRangeTo(index)
                        else toggleOne(index)
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

          {(load.nextPageToken !== null || load.nextOffset !== null) && (
            <div className="loadmore">
              {/*
                Pagination stays manual. Every message on a page costs a
                metadata read, so a 500-message page across three mailboxes is
                already most of a minute's Gmail quota — fetching the rest
                unasked burned through it and the API started refusing. The
                search itself still covers the whole mailbox; this button is
                only about how much of the answer is drawn at once.
              */}
              <span className="hint">
                {load.total !== null
                  ? `Showing ${load.messages.length.toLocaleString()} of ${load.total.toLocaleString()} matches`
                  : total
                    ? `Showing ${load.messages.length.toLocaleString()} of ${total.count.toLocaleString()}${
                        total.truncated ? '+' : ''
                      } matches`
                    : `Showing ${load.messages.length.toLocaleString()} so far`}
              </span>
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

          {/*
            Everything is in, so say the number rather than leaving a list that
            simply stops. A count that ends is the difference between "that is
            all of them" and "that is all it bothered to fetch".
          */}
          {load.nextPageToken === null && load.nextOffset === null && paged && (
            <p className="hint loadmore">
              All {load.messages.length.toLocaleString()} matches loaded.
            </p>
          )}
        </>
      )}

        </div>

        {/*
          One pane, two things that want it. Reading a message wins: it is the
          thing just clicked, and an analysis run that took minutes should not
          be thrown away by opening an email, so it comes back on close.
        */}
        {!reading && analysing && (
          <AnalyticsPanel
            accounts={accounts}
            /*
             * The analysis follows the list it is standing next to. It always
             * measured the whole mailbox, which is a fair default and the
             * wrong answer to "what is in my inbox" — the two numbers sat side
             * by side on the same screen disagreeing, and neither said why.
             */
            folder={mode}
            folderLabel={TITLES[mode]}
            onClose={() => setAnalysing(false)}
            onCleaned={(message) => {
              setNotice(message)
              void refresh()
            }}
            onView={(patch) => {
              /*
               * Fills the list beside the panel rather than replacing it.
               * Deciding whether 812 messages from an address are junk or
               * receipts is a question you answer by looking, and the answer
               * has to be reachable without losing an analysis that took
               * minutes to produce.
               *
               * Several senders arrive as one `from:(a OR b)` clause, because
               * that is a single Gmail query — one page of results to read
               * rather than one per sender.
               */
              const { accountId: scopeId, ...filterPatch } = patch
              const next = { ...EMPTY_FILTERS, ...filterPatch }
              setFilters(next)
              setApplied(next)
              // The panel's mailbox chip narrows the list as well; without
              // this, viewing one account's senders lists every account.
              if (scopeId !== undefined) setAccountId(scopeId)
              setFolderOnly(false)
              setReading(null)
            }}
          />
        )}

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

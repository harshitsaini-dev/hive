import { useEffect, useState } from 'react'
import type { ConnectedAccount } from '@hive/shared-types'
import {
  api,
  ApiRequestError,
  type MailboxAnalysis,
  type SenderTally,
} from './api.js'
import type { MailboxView } from './AppShell.js'
import { ConfirmDialog } from './ConfirmDialog.js'
import { DatePicker } from './DatePicker.js'
import {
  AlertIcon,
  ChartIcon,
  MailIcon,
  PaperclipIcon,
  SearchIcon,
  TrashIcon,
} from './Icons.js'
import { Select } from './Select.js'
import { Skeleton } from './Skeleton.js'

/**
 * What is actually in the mailbox, and who put it there.
 *
 * **Why the two halves are priced so differently.** How many messages match,
 * and how many of those carry a file, come from lists of message ids — 500 an
 * API call, so a hundred thousand of them is a couple of hundred cheap calls
 * and the numbers are exact. Working out *who sent them* needs the `From`
 * header of every single message, one metadata read each, against a quota of
 * roughly three thousand a minute. A hundred thousand messages is therefore
 * about half an hour of solid fetching for the sender list alone.
 *
 * So the run reads the newest slice, says exactly how deep it got, and offers
 * to go deeper. The totals beside it are always for everything. Pretending
 * otherwise would mean a sender list that quietly describes a fraction of the
 * mailbox while looking like it describes all of it.
 */

/*
 * No time estimates on these labels any more.
 *
 * They used to read "about a minute", "can take hours", and so on, which was
 * honest when every run meant a metadata request per message. Once a mailbox
 * is indexed the same run is a grouped scan and finishes immediately, so the
 * warnings became wrong for exactly the people most likely to read them —
 * and a stale scary label is worse than none.
 */
const SCAN_DEPTHS = [
  { value: '2000', label: 'Newest 2,000' },
  { value: '5000', label: 'Newest 5,000' },
  { value: '10000', label: 'Newest 10,000' },
  { value: '20000', label: 'Newest 20,000' },
  { value: '250000', label: 'Everything' },
] as const

/*
 * Drafts and Spam are exactly themselves; everything else is the folder plus
 * `-in:spam`, so an inbox analysis is not quietly a chart of spam.
 */
const FOLDER_QUERY: Record<MailboxView, string> = {
  inbox: 'in:inbox',
  sent: 'in:sent',
  drafts: 'in:drafts',
  spam: 'in:spam',
  trash: 'in:trash',
}

const AGES = [
  { value: '', label: 'Any age' },
  { value: '30d', label: 'Older than a month' },
  { value: '90d', label: 'Older than 3 months' },
  { value: '1y', label: 'Older than a year' },
  { value: '2y', label: 'Older than 2 years' },
] as const

/** `2026-01-31` -> `2026/02/01`, so an inclusive end date reads as one. */
function nextDay(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return isoDate.replace(/-/g, '/')

  date.setUTCDate(date.getUTCDate() + 1)
  const month = `${date.getUTCMonth() + 1}`.padStart(2, '0')
  const day = `${date.getUTCDate()}`.padStart(2, '0')
  return `${date.getUTCFullYear()}/${month}/${day}`
}

function percent(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 100)
}

/*
 * A finished run is kept on the server, not in this browser.
 *
 * localStorage met the "do not throw it away on refresh" half of the
 * requirement and none of the "see it from anywhere" half — and a run is
 * expensive enough to deserve both: reading who sent a message costs one
 * Gmail request per message, against a quota measured per minute.
 *
 * Only counts and sender addresses travel — the same metadata the mailbox
 * list already shows. Message content never reaches the database.
 */
function formatWhen(iso: string): string {
  // SQLite's `datetime('now')` has no zone marker; it is UTC.
  const stamped = /Z|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`
  const date = new Date(stamped.replace(' ', 'T'))

  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export function AnalyticsPanel({
  accounts,
  folder,
  folderLabel,
  onClose,
  onCleaned,
  onView,
}: {
  accounts: ConnectedAccount[]
  /** The list this panel is standing beside. */
  folder: MailboxView
  folderLabel: string
  onClose: () => void
  /** The list behind this is now stale; ask it to refresh. */
  onCleaned: (message: string) => void
  /**
   * Show one sender's mail in the list beside this panel.
   *
   * Clearing a sender on the strength of a number alone is a leap — 812 from
   * an address you half-recognise could be receipts you need. Looking first
   * is the cheap half of the decision, and the list is already there.
   */
  onView: (patch: {
    from?: string
    hasAttachment?: boolean
    raw?: string
    /** Narrow the list to one mailbox, or '' for all of them. */
    accountId?: string
  }) => void
}) {
  const [accountId, setAccountId] = useState('')
  const [olderThan, setOlderThan] = useState('')
  const [after, setAfter] = useState('')
  const [before, setBefore] = useState('')
  const [scanLimit, setScanLimit] = useState('5000')

  const [restoring, setRestoring] = useState(true)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(
    null,
  )
  const [analysis, setAnalysis] = useState<MailboxAnalysis | null>(null)
  const [ranAt, setRanAt] = useState<string | null>(null)
  const [scope, setScope] = useState<{
    accountId: string
    query: string
  } | null>(null)
  /** Which of the three totals the panel is currently narrowed to. */
  const [onlyWith, setOnlyWith] = useState<'all' | 'with' | 'without'>('all')
  /** Which mailbox the panel is narrowed to, or '' for all of them. */
  const [onlyAccount, setOnlyAccount] = useState('')
  /** Widened past the folder on screen, when someone asks for the lot. */
  const [wholeMailbox, setWholeMailbox] = useState(false)
  /** Narrows the sender list by name or address, without another run. */
  const [senderFilter, setSenderFilter] = useState('')
  /** How far a clear has got, so a slow one does not look like a hung one. */
  const [clearing, setClearing] = useState<{
    done: number
    total: number
  } | null>(null)
  /** Senders ticked for a bulk view or clear, by address. */
  const [selected, setSelected] = useState<Set<string>>(new Set())
  /**
   * What is awaiting confirmation before it is trashed.
   *
   * A list of queries rather than one, because a multi-sender clear runs one
   * request per sender: a partial failure then leaves a known state instead
   * of one opaque failure covering all of them.
   */
  const [pendingClear, setPendingClear] = useState<{
    what: string
    count: number
    queries: string[]
  } | null>(null)

  // Restores the last run, filters included, so the panel opens where it was
  // left — on this device or any other.
  useEffect(() => {
    let cancelled = false

    api
      .lastAnalysis()
      .then(({ run, activeJobId }) => {
        if (cancelled) return

        if (run?.result) {
          setAccountId(run.filters.accountId ?? run.accountId ?? '')
          setOlderThan(run.filters.olderThan ?? '')
          setAfter(run.filters.after ?? '')
          setBefore(run.filters.before ?? '')
          setScanLimit(run.filters.scanLimit ?? '5000')

          setAnalysis(run.result)
          setRanAt(run.finishedAt)
          setScope({ accountId: run.accountId ?? '', query: run.query })
        }

        /*
         * A run started before the tab was closed is still going server-side.
         * Reattaching to it rather than starting another is the difference
         * between finishing the work and paying for it twice.
         */
        if (activeJobId) void resume(activeJobId)
      })
      // No saved run, or it could not be read: an empty panel, not an error.
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setRestoring(false)
      })

    return () => {
      cancelled = true
    }
  }, [])
  const [error, setError] = useState<string | null>(null)
  const [cleaning, setCleaning] = useState<string | null>(null)

  /*
   * Spam is excluded rather than included: it is Gmail's own rubbish pile, it
   * is deleted automatically, and leaving it in makes every sender chart a
   * chart of spam.
   */
  function buildQuery(): string {
    /*
     * Scoped to the folder being looked at, unless asked to widen.
     *
     * It was always `-in:spam` — the whole mailbox — which put "10,605
     * messages match" next to an inbox that said 8,361 and left the two
     * disagreeing on screen with nothing to explain the gap. They were
     * answering different questions; now they answer the same one by default.
     */
    const parts = [wholeMailbox ? '-in:spam' : FOLDER_QUERY[folder]]
    if (olderThan) parts.push(`older_than:${olderThan}`)
    if (after) parts.push(`after:${after.replace(/-/g, '/')}`)
    if (before) parts.push(`before:${nextDay(before)}`)
    return parts.join(' ')
  }

  /**
   * The query the actions act on: the run's own filters, narrowed by whichever
   * total is pressed. Kept separate from {@link buildQuery} because the run
   * itself must always cover everything — the attachment split is one of the
   * things it goes and measures.
   */
  function activeQuery(): string {
    const attachment =
      onlyWith === 'with'
        ? ' has:attachment'
        : onlyWith === 'without'
          ? ' -has:attachment'
          : ''
    return `${buildQuery()}${attachment}`
  }

  async function watch(jobId: string) {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 900))
      const job = await api.getJob(jobId)
      setProgress({ done: job.processed, total: job.total })

      if (job.status === 'failed') {
        throw new Error(job.error ?? 'That analysis did not finish.')
      }
      if (job.status === 'done') return job.result
    }
  }

  /** Follows a job that this session did not start. */
  async function resume(jobId: string) {
    setRunning(true)
    setError(null)
    setProgress({ done: 0, total: 0 })

    try {
      const result = await watch(jobId)
      setAnalysis(result)
      setRanAt(new Date().toISOString())
      setSelected(new Set())
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError || caught instanceof Error
          ? caught.message
          : 'That analysis did not finish.',
      )
    } finally {
      setRunning(false)
      setProgress(null)
    }
  }

  async function run() {
    setRunning(true)
    setError(null)
    /*
     * The previous run stays on screen until this one lands. Blanking it made
     * "Run again" feel like it had destroyed the answer, and a scan takes
     * minutes — during which the old numbers are still the best ones there
     * are, and still worth reading.
     */
    // Zero until the job reports the real size; the server only knows it
    // after resolving the query, which is the first thing it does.
    setProgress({ done: 0, total: 0 })

    try {
      const query = buildQuery()
      const { jobId } = await api.analyze({
        accountId: accountId || undefined,
        query,
        scanLimit: Number(scanLimit),
        filters: { accountId, olderThan, after, before, scanLimit },
      })

      // The server stores the run as the job finishes, so nothing is saved
      // from here — this only mirrors what it kept.
      const result = await watch(jobId)
      // Replaced in one step, so the panel never shows half of each run.
      setAnalysis(result)
      setRanAt(new Date().toISOString())
      setScope({ accountId, query })
      setSelected(new Set())
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError || caught instanceof Error
          ? caught.message
          : 'Could not analyse this mailbox.',
      )
    } finally {
      setRunning(false)
      setProgress(null)
    }
  }

  /**
   * Trashes everything from the chosen senders that matches the filters.
   *
   * Trash, never permanent delete — a chart is a place to notice something,
   * not a place to destroy mail from. Anything cleared here is recoverable
   * from the bin for thirty days, and permanent deletion stays where it is:
   * behind a typed confirmation in the Trash view.
   */
  async function clearMatching(target: {
    what: string
    count: number
    queries: string[]
  }) {
    setPendingClear(null)
    setCleaning(target.what)
    setError(null)

    /*
     * The mailbox chip narrows what is acted on, not just what is shown. A
     * figure of 65 that belongs to one account must not clear 200 across
     * three — the number on screen is the promise being kept.
     */
    const scopeId = onlyAccount || accountId
    const accountsToClear = scopeId
      ? accounts.filter((account) => account.id === scopeId)
      : accounts

    /*
     * Progress, because this is slow and looked broken.
     *
     * Clearing a sender resolves the query and then trashes in batches, one
     * account at a time — seconds for a handful, well over a minute for
     * thousands. All of that happened behind a button that said "Clearing…"
     * and nothing else, so the honest reading from the other side of the
     * screen was that the app had hung.
     *
     * The unit is a *step*, not a message: one resolve plus one trash per
     * query per account. Messages would be the more natural unit and the
     * count is not known until each resolve comes back, so a bar measured in
     * them would jump around and finish before the work did.
     */
    const totalSteps = target.queries.length * accountsToClear.length
    let step = 0
    setClearing({ done: 0, total: totalSteps })

    try {
      let trashed = 0

      for (const query of target.queries) {
        for (const account of accountsToClear) {
          const resolved = await api.resolveQuery(account.id, query)
          step += 1
          setClearing({ done: step, total: totalSteps })

          if (resolved.messageIds.length === 0) continue

          await api.trashMessages(
            account.id,
            resolved.messageIds,
            resolved.messageIds.length > 200,
          )
          trashed += resolved.messageIds.length
        }
      }

      onCleaned(
        trashed === 0
          ? `Nothing left matching ${target.what}.`
          : `Moved ${trashed.toLocaleString()} message${trashed === 1 ? '' : 's'} from ${target.what} to Trash.`,
      )

      /*
       * The rows go, but the run is not re-scanned — that costs minutes. The
       * stored copy still lists them until the next run, which is accepted:
       * correcting it would mean a write per cleared sender, and the saved
       * figures are already a snapshot of a mailbox that keeps moving.
       */
      setAnalysis((current) => {
        if (!current) return current
        const cleared = new Set(
          chosen.length > 0 ? chosen.map((sender) => sender.address) : [],
        )
        return cleared.size > 0
          ? {
              ...current,
              senders: current.senders.filter(
                (entry) => !cleared.has(entry.address),
              ),
            }
          : current
      })
      setSelected(new Set())
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError
          ? caught.message
          : 'Could not clear that. Anything already moved stayed moved.',
      )
    } finally {
      setCleaning(null)
      setClearing(null)
    }
  }

  /** One request per sender, for the reason on `pendingClear`. */
  function askClearSenders(list: SenderTally[]) {
    setPendingClear({
      what:
        list.length === 1
          ? (list[0]?.address ?? 'that sender')
          : `${list.length} senders`,
      count: list.reduce((sum, sender) => sum + sender.count, 0),
      queries: list.map(
        (sender) => `${activeQuery()} from:${sender.address} -in:trash`,
      ),
    })
  }

  const busy = running || cleaning !== null

  /*
   * Recounted rather than re-fetched. Each sender's total and its attachment
   * count are both already known, so the third figure is subtraction — and a
   * sender who contributes nothing to the pressed view drops out rather than
   * sitting there as a zero.
   */
  const shown = (analysis?.senders ?? [])
    .map((sender) => {
      // Narrowed to one mailbox, that mailbox's slice of the sender is the
      // whole story; otherwise it is the sender's total across all of them.
      const scoped = onlyAccount
        ? (sender.byAccount?.[onlyAccount] ?? {
            count: 0,
            withAttachment: 0,
          })
        : { count: sender.count, withAttachment: sender.withAttachment }

      return {
        ...sender,
        count:
          onlyWith === 'with'
            ? scoped.withAttachment
            : onlyWith === 'without'
              ? scoped.count - scoped.withAttachment
              : scoped.count,
        withAttachment: scoped.withAttachment,
      }
    })
    .filter((sender) => sender.count > 0)
    .filter((sender) => {
      const needle = senderFilter.trim().toLowerCase()
      if (!needle) return true
      return (
        sender.address.toLowerCase().includes(needle) ||
        sender.name.toLowerCase().includes(needle)
      )
    })
    .sort((a, b) => b.count - a.count)

  /*
   * The headline figures follow the chosen mailbox as well. They come from the
   * per-account totals the run already recorded, so switching mailbox is
   * arithmetic rather than another scan.
   */
  const scopedAccount = onlyAccount
    ? analysis?.accounts.find((entry) => entry.accountId === onlyAccount)
    : undefined
  const scopedTotal = scopedAccount?.count ?? analysis?.total ?? 0
  const scopedAttached = scopedAccount?.withAttachment ?? analysis?.withAttachment ?? 0

  const chosen = shown.filter((sender) => selected.has(sender.address))

  /** The attachment condition, in the shape the mail view's filters take. */
  const viewPatch = {
    hasAttachment: onlyWith === 'with',
    raw: onlyWith === 'without' ? '-has:attachment' : '',
    accountId: onlyAccount || accountId,
  }
  const allTicked = shown.length > 0 && chosen.length === shown.length
  const top = shown[0]?.count ?? 0

  /*
   * A restored run describes the filters it was run with, not whatever the
   * controls say now. Clearing a sender builds its query from the controls,
   * so acting on a stale result would trash a different set of mail than the
   * number on screen — the actions are withheld until it is re-run.
   */
  const stale =
    analysis !== null &&
    scope !== null &&
    (scope.accountId !== accountId || scope.query !== buildQuery())

  return (
    <aside className="reader analytics" aria-label="Mailbox analysis">
      <div className="reader__head">
        <h2 className="analytics__title">
          <ChartIcon size={18} />
          Mailbox analysis
        </h2>
        <button type="button" className="btn-quiet" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="analytics__controls">
        {/*
          Shown even with one mailbox connected. "All connected accounts" is
          the answer to a question people actually ask of this panel, and a
          control that appears only once a second account exists is a control
          nobody knows is there.
        */}
        <Select
          label="Account to analyse"
          className="analytics__field"
          value={accountId}
          options={[
            { value: '', label: 'All connected accounts' },
            ...accounts.map((account) => ({
              value: account.id,
              label: account.gmailAddress,
            })),
          ]}
          onChange={setAccountId}
        />

        <Select
          label="Age"
          className="analytics__field"
          value={olderThan}
          options={AGES}
          onChange={setOlderThan}
        />

        <div className="analytics__dates">
          <span className="formlabel">Between</span>
          <DatePicker
            label="Analysis start date"
            placeholder="Any earlier date"
            value={after}
            max={before || undefined}
            onChange={setAfter}
          />
          <span className="hint">and</span>
          <DatePicker
            label="Analysis end date"
            placeholder="Any later date"
            value={before}
            min={after || undefined}
            onChange={setBefore}
          />
        </div>

        {/*
          Said out loud, because the number below depends on it and a total
          that silently means something other than the list beside it is how
          this confused someone in the first place.
        */}
        <div className="analytics__scope">
          <span className="hint">
            {wholeMailbox
              ? 'Measuring the whole mailbox'
              : `Measuring ${folderLabel}`}
          </span>
          <button
            type="button"
            className="btn-quiet"
            onClick={() => setWholeMailbox(!wholeMailbox)}
          >
            {wholeMailbox ? `Just ${folderLabel}` : 'Whole mailbox'}
          </button>
        </div>

        <Select
          label="How deep to read senders"
          className="analytics__field"
          value={scanLimit}
          options={SCAN_DEPTHS}
          onChange={setScanLimit}
        />

        <button
          type="button"
          className="icon-btn"
          disabled={busy}
          onClick={() => void run()}
        >
          <ChartIcon size={15} />
          {running ? 'Analysing…' : analysis ? 'Run again' : 'Analyse'}
        </button>
      </div>

      <div role="status" aria-live="polite">
        {clearing && (
          <div className="progress analytics__progress">
            <div className="progress__label">
              <span>Moving to Trash…</span>
              <span>
                {clearing.done} of {clearing.total}
              </span>
            </div>
            <div
              className="progress__track"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={clearing.total}
              aria-valuenow={clearing.done}
            >
              <div
                className="progress__bar"
                style={{
                  width: `${percent(clearing.done, Math.max(clearing.total, 1))}%`,
                }}
              />
            </div>
          </div>
        )}

        {running && progress && (
          <div className="progress analytics__progress">
            <div className="progress__label">
              <span>
                {analysis
                  ? 'Refreshing — showing the last run'
                  : 'Reading senders… you can close this and come back'}
              </span>
              <span>
                {progress.total > 0
                  ? `${progress.done.toLocaleString()} of ${progress.total.toLocaleString()}`
                  : 'counting…'}
              </span>
            </div>
            <div
              className="progress__track"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={progress.total}
              aria-valuenow={progress.done}
            >
              <div
                className="progress__bar"
                style={{
                  width: `${percent(progress.done, Math.max(progress.total, 1))}%`,
                }}
              />
            </div>
          </div>
        )}
      </div>

      <div role="alert" aria-live="assertive">
        {error && <p className="bad">{error}</p>}
      </div>

      {running && !analysis && (
        <div className="analytics__skeleton" aria-hidden="true">
          <Skeleton height="4.5rem" radius="0.75rem" />
          {[0, 1, 2, 3, 4].map((row) => (
            <Skeleton key={row} height="2.2rem" radius="0.5rem" />
          ))}
        </div>
      )}

      {!running && !analysis && !error && (
        <p className="hint analytics__intro">
          Counts how much mail matches, how much of it carries a file, and who
          sent it — then lets you clear a sender out in one go. The totals
          cover everything that matches. So does the sender list once a
          mailbox has finished indexing; until then it reads the newest slice
          you choose, and says so.
        </p>
      )}

      {pendingClear && (
        <ConfirmDialog
          title={`Move ${pendingClear.what} to Trash?`}
          body={`Around ${pendingClear.count.toLocaleString()} message${
            pendingClear.count === 1 ? '' : 's'
          } matching the current filters move to Trash. They stay recoverable there for thirty days.`}
          confirmLabel="Move to Trash"
          busy={cleaning !== null}
          onCancel={() => setPendingClear(null)}
          onConfirm={() => void clearMatching(pendingClear)}
        />
      )}

      {analysis && (
        <>
          {ranAt && (
            <p className="hint analytics__when">
              {stale
                ? 'Filters have changed since this run — the numbers below are from the old ones.'
                : `Last run ${formatWhen(ranAt)}. Kept on this device, so a reload does not throw it away.`}
            </p>
          )}

          {/*
            The three totals are the filter, not decoration beside one. The
            whole panel below narrows to whichever is pressed, which costs
            nothing to compute: a per-sender total and its attachment count
            already imply the third figure, so switching between them is
            arithmetic on a run that has already happened rather than another
            few minutes of Gmail quota.
          */}
          <div className="analytics__totals" role="group" aria-label="Show">
            {(
              [
                { key: 'all', value: scopedTotal, label: 'messages match' },
                {
                  key: 'with',
                  value: scopedAttached,
                  label: `with attachments (${percent(scopedAttached, scopedTotal)}%)`,
                },
                {
                  key: 'without',
                  value: Math.max(0, scopedTotal - scopedAttached),
                  label: 'without',
                },
              ] as const
            ).map((stat) => (
              <button
                key={stat.key}
                type="button"
                className="analytics__stat"
                aria-pressed={onlyWith === stat.key}
                onClick={() => setOnlyWith(stat.key)}
              >
                <strong>{stat.value.toLocaleString()}</strong>
                <span className="hint">{stat.label}</span>
              </button>
            ))}
          </div>

          {/*
            Mailboxes, narrowing the same list. Only worth drawing when a run
            covered more than one — with a single account the chip would be a
            button whose only state is the one already showing.
          */}
          {analysis.accounts.length > 1 && (
            <div
              className="analytics__mailboxes"
              role="group"
              aria-label="Mailbox"
            >
              <button
                type="button"
                className="analytics__chip"
                aria-pressed={onlyAccount === ''}
                onClick={() => setOnlyAccount('')}
              >
                All connected
                <span className="hint">{analysis.total.toLocaleString()}</span>
              </button>

              {analysis.accounts.map((entry) => (
                <button
                  key={entry.accountId}
                  type="button"
                  className="analytics__chip"
                  aria-pressed={onlyAccount === entry.accountId}
                  onClick={() => setOnlyAccount(entry.accountId)}
                >
                  {entry.gmailAddress}
                  <span className="hint">{entry.count.toLocaleString()}</span>
                </button>
              ))}
            </div>
          )}

          {/* One bar, because two numbers that add to a whole is one bar. */}
          <div className="analytics__split" aria-hidden="true">
            <span
              className="analytics__split-fill"
              style={{ width: `${percent(scopedAttached, scopedTotal)}%` }}
            />
          </div>

          <h3 className="analytics__subtitle">
            Top senders
            <span className="hint">
              from the newest {analysis.scanned.toLocaleString()}
              {analysis.truncated && analysis.scanned < analysis.total
                ? ` of ${analysis.total.toLocaleString()}`
                : ''}
            </span>
          </h3>

          {analysis.truncated && analysis.scanned < analysis.total && (
            <p className="mailbox__truncated analytics__note">
              <AlertIcon size={15} />
              This is not the whole mailbox. Reading who sent a message costs a
              Gmail request per message, so the list covers the newest{' '}
              {analysis.scanned.toLocaleString()}. Choose a deeper scan, or
              narrow the dates, to see further back.
            </p>
          )}

          {shown.length === 0 ? (
            <p className="hint">
              {onlyWith === 'all'
                ? 'Nothing matched those filters.'
                : `No senders in the scanned slice sent mail ${
                    onlyWith === 'with' ? 'with' : 'without'
                  } attachments.`}
            </p>
          ) : (
            <>
              {/*
                Tick several, act once. Clearing eleven newsletters one
                confirmation at a time is eleven chances to misclick and a lot
                of waiting — and the reason to rank senders at all is that the
                junk arrives in clumps.
              */}
              {/*
                Filtering, not re-running. The senders are already in hand, so
                narrowing them is typing — not another few minutes of Gmail
                quota to answer a question the last run already covered.
              */}
              <div className="search-field analytics__find">
                <SearchIcon size={15} />
                <label htmlFor="sender-search" className="sr-only">
                  Find a sender
                </label>
                <input
                  id="sender-search"
                  type="search"
                  value={senderFilter}
                  placeholder="Find a sender in these results"
                  onChange={(event) => setSenderFilter(event.target.value)}
                />
              </div>

              <div className="analytics__selectbar">
                <label className="checkline">
                  <input
                    type="checkbox"
                    checked={allTicked}
                    onChange={(event) =>
                      setSelected(
                        event.target.checked
                          ? new Set(
                              shown.map((sender) => sender.address),
                            )
                          : new Set(),
                      )
                    }
                  />
                  Select all
                </label>

                {chosen.length > 0 && (
                  <>
                    <span className="hint">
                      {chosen.length} selected ·{' '}
                      {chosen
                        .reduce((sum, sender) => sum + sender.count, 0)
                        .toLocaleString()}{' '}
                      messages
                    </span>
                    <button
                      type="button"
                      className="btn-quiet analytics__act"
                      onClick={() =>
                        onView({
                          ...viewPatch,
                          from: `(${chosen
                            .map((sender) => sender.address)
                            .join(' OR ')})`,
                        })
                      }
                    >
                      <MailIcon size={13} />
                      View
                    </button>
                    <button
                      type="button"
                      className="btn-quiet analytics__act"
                      disabled={busy || stale}
                      onClick={() => askClearSenders(chosen)}
                    >
                      <TrashIcon size={13} />
                      Clear
                    </button>
                  </>
                )}
              </div>

              <ul className="analytics__senders">
                {shown.map((sender) => (
                  <li key={sender.address}>
                    <div className="analytics__sender">
                      <input
                        type="checkbox"
                        aria-label={`Select ${sender.address}`}
                        checked={selected.has(sender.address)}
                        onChange={(event) => {
                          const next = new Set(selected)
                          if (event.target.checked) next.add(sender.address)
                          else next.delete(sender.address)
                          setSelected(next)
                        }}
                      />

                      <span className="analytics__who">
                        <strong>{sender.name || sender.address}</strong>
                        {sender.name && (
                          <span className="hint">{sender.address}</span>
                        )}
                      </span>

                      <span className="analytics__count">
                        {sender.count.toLocaleString()}
                        {onlyWith === 'all' && sender.withAttachment > 0 && (
                          <span
                            className="hint analytics__attached"
                            title={`${sender.withAttachment} with attachments`}
                          >
                            <PaperclipIcon size={12} />
                            {sender.withAttachment.toLocaleString()}
                          </span>
                        )}
                      </span>

                      <span className="analytics__actions">
                        <button
                          type="button"
                          className="btn-quiet analytics__act"
                          onClick={() =>
                            onView({ ...viewPatch, from: sender.address })
                          }
                        >
                          <MailIcon size={13} />
                          View
                        </button>
                        <button
                          type="button"
                          className="btn-quiet analytics__act"
                          disabled={busy || stale}
                          onClick={() => askClearSenders([sender])}
                        >
                          <TrashIcon size={13} />
                          {cleaning?.includes(sender.address)
                            ? 'Clearing…'
                            : 'Clear'}
                        </button>
                      </span>
                    </div>

                    {/* Relative to the top sender, so the shape is readable. */}
                    <span
                      className="analytics__bar"
                      aria-hidden="true"
                      style={{ width: `${percent(sender.count, top)}%` }}
                    />
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </aside>
  )
}

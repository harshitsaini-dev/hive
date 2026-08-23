import { useState } from 'react'
import type { ConnectedAccount } from '@hive/shared-types'
import {
  api,
  ApiRequestError,
  type MailboxAnalysis,
  type SenderTally,
} from './api.js'
import { DatePicker } from './DatePicker.js'
import {
  AlertIcon,
  ChartIcon,
  MailIcon,
  PaperclipIcon,
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
 * Roughly a minute per three thousand messages, because that is Gmail's quota
 * for reading headers. The labels say so rather than leaving someone to
 * discover it by waiting.
 */
const SCAN_DEPTHS = [
  { value: '2000', label: 'Newest 2,000 — about a minute' },
  { value: '5000', label: 'Newest 5,000 — a few minutes' },
  { value: '10000', label: 'Newest 10,000 — slow' },
  { value: '20000', label: 'Newest 20,000 — very slow' },
  { value: '250000', label: 'Everything — can take hours' },
] as const

/** The value that means "no slice, read them all". */
const EVERYTHING = '250000'

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
 * A finished run is kept in the browser so a reload does not throw away
 * something that took minutes — and, on a large mailbox, a slice of that
 * minute's Gmail quota. Only counts and sender addresses are stored: the same
 * metadata already on screen, on the reader's own device, never a message
 * body. Every access is guarded because storage throws outright in a private
 * window and in browsers set to block site data.
 */
const SAVED_KEY = 'hive.analysis.v1'

interface SavedRun {
  /** What the run was scoped to, so a changed filter can be spotted. */
  scope: { accountId: string; query: string }
  finishedAt: number
  filters: {
    accountId: string
    olderThan: string
    after: string
    before: string
    scanLimit: string
  }
  analysis: MailboxAnalysis
}

function loadSaved(): SavedRun | null {
  try {
    const raw = window.localStorage.getItem(SAVED_KEY)
    if (!raw) return null

    const parsed = JSON.parse(raw) as SavedRun
    // Shape-checked rather than trusted: an older build's payload should be
    // ignored, not rendered into a crash.
    return parsed?.analysis && typeof parsed.analysis.total === 'number'
      ? parsed
      : null
  } catch {
    return null
  }
}

function saveRun(run: SavedRun): void {
  try {
    window.localStorage.setItem(SAVED_KEY, JSON.stringify(run))
  } catch {
    // A run that cannot be cached is still a run that happened.
  }
}

function formatWhen(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

export function AnalyticsPanel({
  accounts,
  onClose,
  onCleaned,
  onView,
}: {
  accounts: ConnectedAccount[]
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
  onView: (sender: SenderTally) => void
}) {
  // Read once, in an initialiser: re-reading on every render would fight the
  // controls the moment someone changed one.
  const [saved] = useState(loadSaved)

  const [accountId, setAccountId] = useState(saved?.filters.accountId ?? '')
  const [olderThan, setOlderThan] = useState(saved?.filters.olderThan ?? '')
  const [after, setAfter] = useState(saved?.filters.after ?? '')
  const [before, setBefore] = useState(saved?.filters.before ?? '')
  const [scanLimit, setScanLimit] = useState(saved?.filters.scanLimit ?? '5000')

  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(
    null,
  )
  const [analysis, setAnalysis] = useState<MailboxAnalysis | null>(
    saved?.analysis ?? null,
  )
  const [ranAt, setRanAt] = useState<number | null>(saved?.finishedAt ?? null)
  const [scope, setScope] = useState(saved?.scope ?? null)
  const [error, setError] = useState<string | null>(null)
  const [cleaning, setCleaning] = useState<string | null>(null)

  /*
   * Spam is excluded rather than included: it is Gmail's own rubbish pile, it
   * is deleted automatically, and leaving it in makes every sender chart a
   * chart of spam.
   */
  function buildQuery(): string {
    const parts = ['-in:spam']
    if (olderThan) parts.push(`older_than:${olderThan}`)
    if (after) parts.push(`after:${after.replace(/-/g, '/')}`)
    if (before) parts.push(`before:${nextDay(before)}`)
    return parts.join(' ')
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

  async function run() {
    setRunning(true)
    setError(null)
    setAnalysis(null)
    // Zero until the job reports the real size; the server only knows it
    // after resolving the query, which is the first thing it does.
    setProgress({ done: 0, total: 0 })

    try {
      const query = buildQuery()
      const { jobId } = await api.analyze({
        accountId: accountId || undefined,
        query,
        scanLimit: Number(scanLimit),
      })

      const result = await watch(jobId)
      const finishedAt = Date.now()

      setAnalysis(result)
      setRanAt(finishedAt)
      setScope({ accountId, query })
      if (result) {
        saveRun({
          scope: { accountId, query },
          finishedAt,
          filters: { accountId, olderThan, after, before, scanLimit },
          analysis: result,
        })
      }
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
   * Trashes everything from one sender that matches the current filters.
   *
   * Trash, never permanent delete — a chart is a place to notice something,
   * not a place to destroy mail from. Anything cleared here is recoverable
   * from the bin for thirty days, and permanent deletion stays where it is:
   * behind a typed confirmation in the Trash view.
   */
  async function clearSender(sender: SenderTally) {
    // Same filters the numbers were produced under; `stale` guards the case
    // where they have since drifted.
    const query = `${buildQuery()} from:${sender.address} -in:trash`

    const confirmed = window.confirm(
      `Move every message from ${sender.address} matching these filters to Trash?\n\n` +
        'They stay recoverable in Trash for thirty days.',
    )
    if (!confirmed) return

    setCleaning(sender.address)
    setError(null)

    try {
      const targets = accountId
        ? accounts.filter((account) => account.id === accountId)
        : accounts

      let trashed = 0
      for (const account of targets) {
        const resolved = await api.resolveQuery(account.id, query)
        if (resolved.messageIds.length === 0) continue

        await api.trashMessages(
          account.id,
          resolved.messageIds,
          resolved.messageIds.length > 200,
        )
        trashed += resolved.messageIds.length
      }

      onCleaned(
        trashed === 0
          ? `Nothing left from ${sender.address}.`
          : `Moved ${trashed.toLocaleString()} message${trashed === 1 ? '' : 's'} from ${sender.address} to Trash.`,
      )

      // Drop the row rather than re-running a scan that costs minutes — and
      // drop it from the cache too, or a reload brings back a sender whose
      // mail is already in the bin.
      setAnalysis((current) => {
        if (!current) return current

        const next = {
          ...current,
          senders: current.senders.filter(
            (entry) => entry.address !== sender.address,
          ),
        }

        if (ranAt && scope) {
          saveRun({
            scope,
            finishedAt: ranAt,
            filters: { accountId, olderThan, after, before, scanLimit },
            analysis: next,
          })
        }

        return next
      })
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError
          ? caught.message
          : 'Could not clear that sender.',
      )
    } finally {
      setCleaning(null)
    }
  }

  const busy = running || cleaning !== null
  const top = analysis?.senders[0]?.count ?? 0

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
        {accounts.length > 1 && (
          <Select
            label="Account to analyse"
            className="analytics__field"
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
        )}

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

        <Select
          label="How deep to read senders"
          className="analytics__field"
          value={scanLimit}
          options={SCAN_DEPTHS}
          onChange={setScanLimit}
        />

        {scanLimit === EVERYTHING && (
          <p className="hint analytics__warn">
            <AlertIcon size={14} />
            Reading who sent a message costs one Gmail request per message, and
            Gmail allows about three thousand a minute. A hundred thousand
            messages is over half an hour of fetching — narrowing the dates
            first is usually the faster way to the same answer.
          </p>
        )}

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
        {running && progress && (
          <div className="progress analytics__progress">
            <div className="progress__label">
              <span>Reading senders…</span>
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
          sent it — then lets you clear a sender out in one go. The two totals
          cover everything that matches; the sender list reads the newest slice
          you choose, because that part costs a Gmail request per message.
        </p>
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

          <div className="analytics__totals">
            <div className="analytics__stat">
              <strong>{analysis.total.toLocaleString()}</strong>
              <span className="hint">messages match</span>
            </div>
            <div className="analytics__stat">
              <strong>{analysis.withAttachment.toLocaleString()}</strong>
              <span className="hint">
                with attachments ({percent(analysis.withAttachment, analysis.total)}
                %)
              </span>
            </div>
            <div className="analytics__stat">
              <strong>{analysis.withoutAttachment.toLocaleString()}</strong>
              <span className="hint">without</span>
            </div>
          </div>

          {/* One bar, because two numbers that add to a whole is one bar. */}
          <div className="analytics__split" aria-hidden="true">
            <span
              className="analytics__split-fill"
              style={{
                width: `${percent(analysis.withAttachment, analysis.total)}%`,
              }}
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

          {analysis.senders.length === 0 ? (
            <p className="hint">Nothing matched those filters.</p>
          ) : (
            <ul className="analytics__senders">
              {analysis.senders.map((sender) => (
                <li key={sender.address}>
                  <div className="analytics__sender">
                    <span className="analytics__who">
                      <strong>{sender.name || sender.address}</strong>
                      {sender.name && (
                        <span className="hint">{sender.address}</span>
                      )}
                    </span>

                    <span className="analytics__count">
                      {sender.count.toLocaleString()}
                      {sender.withAttachment > 0 && (
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
                        onClick={() => onView(sender)}
                      >
                        <MailIcon size={13} />
                        View
                      </button>
                      <button
                        type="button"
                        className="btn-quiet analytics__act"
                        disabled={busy || stale}
                        onClick={() => void clearSender(sender)}
                      >
                        <TrashIcon size={13} />
                        {cleaning === sender.address ? 'Clearing…' : 'Clear'}
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
          )}
        </>
      )}
    </aside>
  )
}

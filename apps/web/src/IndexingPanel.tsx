import { useState } from 'react'
import type { ConnectedAccount, SyncProgress } from '@hive/shared-types'
import { api, ApiRequestError } from './api.js'
import { ConfirmDialog } from './ConfirmDialog.js'
import { AlertIcon, ChartIcon } from './Icons.js'

/**
 * Control over the background index, beside the cleanup rules.
 *
 * This replaced a "scheduled analysis" card. Scheduling an analysis made
 * sense while every run meant one Gmail request per message and therefore
 * minutes of waiting — doing it overnight and reading the answer in the
 * morning was strictly better. The index removed the reason: a run against an
 * indexed mailbox finishes immediately. What is worth keeping current is the
 * index itself, and that is what this is about.
 *
 * It lives here rather than on Accounts because this is the page for work
 * Hive does while nobody is watching. Accounts is for connecting and
 * disconnecting.
 */
/**
 * A stored timestamp, or a plain "in N minutes" when that reads better.
 *
 * SQLite's `datetime('now')` carries no zone marker and is UTC; an ISO string
 * from the server already says so. Both arrive here.
 */
function formatWhen(iso: string): string {
  const stamped = /Z|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`
  const at = new Date(stamped.replace(' ', 'T'))
  if (Number.isNaN(at.getTime())) return iso

  const minutes = Math.round((at.getTime() - Date.now()) / 60_000)
  if (minutes <= 0) return 'any moment'
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? '' : 's'}`

  return `at ${at.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })}`
}

/**
 * Whether an index is holding messages the mailbox no longer has.
 *
 * A tenth of slack, because the two numbers are taken at different moments
 * and Gmail counts drafts and chats in its own total. Below that, the
 * difference is noise; well above it, the index is stale in the one way it
 * cannot fix by itself.
 */
function stale(sync: SyncProgress | undefined): boolean {
  if (!sync || sync.backfilling || !sync.estimate) return false
  return sync.indexed > sync.estimate * 1.1
}

export function IndexingPanel({
  accounts,
  onChanged,
}: {
  accounts: ConnectedAccount[]
  onChanged: () => Promise<void> | void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  /** The mailbox awaiting confirmation before its index is thrown away. */
  const [pendingRebuild, setPendingRebuild] = useState<ConnectedAccount | null>(
    null,
  )
  const [error, setError] = useState<string | null>(null)

  async function act(accountId: string, work: () => Promise<unknown>) {
    setBusy(accountId)
    setError(null)

    try {
      await work()
      await onChanged()
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError
          ? caught.message
          : 'That did not work.',
      )
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="card">
      <div className="card__head">
        <h2>
          <ChartIcon size={17} />
          Indexing
        </h2>
      </div>

      <p className="hint">
        Hive keeps a local index of who sent what, so searching and analysing
        do not mean asking Gmail about every message one at a time. It checks
        every ten minutes on its own, and picks up again by itself after
        Gmail rate-limits it — there is nothing you need to press. Sender,
        subject, date and labels only, never the contents of a message.
      </p>

      {accounts.length === 0 ? (
        <p className="hint">Connect a mailbox and indexing starts on its own.</p>
      ) : (
        <ul className="indexing">
          {accounts.map((account) => {
            const sync = account.sync
            const done = sync && !sync.backfilling

            return (
              <li key={account.id}>
                <div className="indexing__who">
                  <strong>{account.gmailAddress}</strong>

                  <span className="hint">
                    {sync?.paused
                      ? `Paused — ${(sync.indexed ?? 0).toLocaleString()} indexed so far`
                      : sync?.error
                        ? `Stopped: ${sync.error}`
                        : done
                          ? `Indexed ${sync.indexed.toLocaleString()} messages`
                          : `Indexing — ${(sync?.indexed ?? 0).toLocaleString()}${
                              /*
                               * Only when it is not obviously nonsense. Gmail's
                               * own `resultSizeEstimate` once reported 501 for
                               * a mailbox of tens of thousands, which produced
                               * "26,829 of about 501" — a number that destroys
                               * confidence in the two beside it.
                               */
                              sync?.estimate && sync.estimate >= sync.indexed
                                ? ` of about ${sync.estimate.toLocaleString()}`
                                : ''
                            } so far`}
                  </span>

                  {/*
                    A backfill on a large mailbox is hours of work spread over
                    many passes. A bar is the difference between "this is
                    progressing" and "this is stuck".
                  */}
                  {sync && !done && sync.estimate && sync.estimate >= sync.indexed ? (
                    <span className="indexing__track" aria-hidden="true">
                      <span
                        className="indexing__bar"
                        style={{
                          width: `${Math.min(100, Math.round((sync.indexed / sync.estimate) * 100))}%`,
                        }}
                      />
                    </span>
                  ) : null}
                  {/*
                    Said out loud, because work that happens on its own is
                    indistinguishable from work that has stopped — which is
                    what turned "Index now" from a nudge into a habit.
                  */}
                  {/*
                    An index that has drifted cannot notice on its own.
                    `history.list` only reports what happened after its cursor,
                    so mail deleted before that — or while the first pass was
                    still running — stays indexed for good. Comparing the two
                    counts is the only thing that can see it.
                  */}
                  {stale(sync) && (
                    <span className="hint indexing__stale">
                      <AlertIcon size={13} />
                      This index is out of date — it holds more than the
                      mailbox does. Rebuild it to drop what has been deleted.
                    </span>
                  )}

                  {sync?.nextRunAt && !sync.paused && (
                    <span className="hint indexing__next">
                      Next check {formatWhen(sync.nextRunAt)}
                      {sync.error ? ' — it will try again then' : ''}
                    </span>
                  )}
                </div>

                <div className="indexing__actions">
                  <button
                    type="button"
                    className="btn-quiet"
                    disabled={busy === account.id || sync?.paused}
                    onClick={() =>
                      void act(account.id, () => api.syncAccount(account.id))
                    }
                  >
                    {busy === account.id ? 'Working…' : 'Index now'}
                  </button>

                  <button
                    type="button"
                    className="btn-quiet"
                    disabled={busy === account.id}
                    onClick={() => setPendingRebuild(account)}
                  >
                    Rebuild
                  </button>

                  <button
                    type="button"
                    className="btn-quiet"
                    disabled={busy === account.id}
                    onClick={() =>
                      void act(account.id, () =>
                        api.setIndexing(account.id, !sync?.paused),
                      )
                    }
                  >
                    {sync?.paused ? 'Resume' : 'Pause'}
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {/*
        Said once, here, because it is the one thing about indexing that costs
        anything: the first pass over a mailbox reads every message.
      */}
      <p className="hint indexing__note">
        <AlertIcon size={14} />
        The first pass over a large mailbox takes a while, spread across many
        short runs so it never monopolises the connection. Everything after
        that is only what changed.
      </p>

      <div role="alert" aria-live="assertive">
        {error && <p className="bad">{error}</p>}
      </div>

      {pendingRebuild && (
        <ConfirmDialog
          title={`Rebuild the index for ${pendingRebuild.gmailAddress}?`}
          body="Hive reads the whole mailbox again from scratch. Nothing in Gmail changes and nothing is deleted — but searching and analysing fall back to asking Gmail directly until it finishes, which is slower. On a large mailbox this takes a while."
          confirmLabel="Rebuild index"
          busy={busy === pendingRebuild.id}
          onCancel={() => setPendingRebuild(null)}
          onConfirm={() => {
            const account = pendingRebuild
            setPendingRebuild(null)
            void act(account.id, () => api.reindexAccount(account.id))
          }}
        />
      )}
    </section>
  )
}

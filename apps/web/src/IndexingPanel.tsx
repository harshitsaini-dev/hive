import { useState } from 'react'
import type { ConnectedAccount } from '@hive/shared-types'
import { api, ApiRequestError } from './api.js'
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
export function IndexingPanel({
  accounts,
  onChanged,
}: {
  accounts: ConnectedAccount[]
  onChanged: () => Promise<void> | void
}) {
  const [busy, setBusy] = useState<string | null>(null)
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
        do not mean asking Gmail about every message one at a time. It updates
        itself every hour. Sender, subject, date and labels only — never the
        contents of a message.
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
                              sync?.estimate
                                ? ` of about ${sync.estimate.toLocaleString()}`
                                : ''
                            } so far`}
                  </span>

                  {/*
                    A backfill on a large mailbox is hours of work spread over
                    hourly passes. A bar is the difference between "this is
                    progressing" and "this is stuck".
                  */}
                  {sync && !done && sync.estimate ? (
                    <span className="indexing__track" aria-hidden="true">
                      <span
                        className="indexing__bar"
                        style={{
                          width: `${Math.min(100, Math.round((sync.indexed / sync.estimate) * 100))}%`,
                        }}
                      />
                    </span>
                  ) : null}
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
        The first pass over a large mailbox takes several hours, spread across
        hourly runs so it never monopolises the connection. Everything after
        that is only what changed.
      </p>

      <div role="alert" aria-live="assertive">
        {error && <p className="bad">{error}</p>}
      </div>
    </section>
  )
}

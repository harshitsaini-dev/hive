import { useEffect, useState } from 'react'
import type { ConnectedAccount } from '@hive/shared-types'
import { api, ApiRequestError, type AnalysisSchedule } from './api.js'
import { ChartIcon } from './Icons.js'
import { Select } from './Select.js'

/**
 * Runs a mailbox analysis on a schedule, so the answer is already there.
 *
 * A run is expensive in a way that is easy to miss: working out who sent each
 * message takes one Gmail request per message, against a quota of about three
 * thousand a minute. On a large mailbox that is minutes of waiting, and it
 * comes out of the same allowance the rest of the app needs. Doing it
 * overnight and reading the result in the morning is strictly better.
 *
 * **A schedule can never delete anything.** It produces numbers and stores
 * them; clearing mail still needs a person to press the button and confirm.
 * That is not an oversight to be tidied up later — an automated irreversible
 * action against a query written weeks ago is the worst failure mode this
 * project has available to it. See ADR 0002.
 */

const CADENCES = [
  { value: 'daily', label: 'Every day' },
  { value: 'weekly', label: 'Every week' },
] as const

const DEPTHS = [
  { value: '2000', label: 'Newest 2,000' },
  { value: '5000', label: 'Newest 5,000' },
  { value: '10000', label: 'Newest 10,000' },
  { value: '20000', label: 'Newest 20,000' },
  { value: '250000', label: 'Everything' },
] as const

const HOURS = Array.from({ length: 24 }, (_, hour) => ({
  value: `${hour}`,
  label: `${`${hour}`.padStart(2, '0')}:00`,
}))

/*
 * The server stores the time in UTC because it has no idea what zone anyone
 * is in. The browser does, so the conversion happens here — in both
 * directions, or a schedule set for 3am would drift every time it was
 * reopened.
 *
 * In minutes, not hours. 03:00 in India is 21:30 UTC; storing that as hour 21
 * and converting it back gives 02:00, so the schedule walks backwards an hour
 * each time the page is opened. Half-hour offsets are not an edge case worth
 * rounding away — a good few hundred million people live in one.
 */
function localHourToUtcMinutes(hour: number): number {
  const local = new Date()
  local.setHours(hour, 0, 0, 0)
  return local.getUTCHours() * 60 + local.getUTCMinutes()
}

function utcMinutesToLocalHour(minuteUtc: number): number {
  const utc = new Date()
  utc.setUTCHours(Math.floor(minuteUtc / 60), minuteUtc % 60, 0, 0)
  return utc.getHours()
}

function formatWhen(iso: string): string {
  // SQLite's `datetime('now')` has no zone marker; it is UTC.
  const stamped = /Z|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`
  const date = new Date(stamped.replace(' ', 'T'))

  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export function AnalysisScheduleCard({
  accounts,
}: {
  accounts: ConnectedAccount[]
}) {
  const [loading, setLoading] = useState(true)
  const [enabled, setEnabled] = useState(false)
  const [cadence, setCadence] = useState<'daily' | 'weekly'>('daily')
  const [hour, setHour] = useState('3')
  const [accountId, setAccountId] = useState('')
  const [scanLimit, setScanLimit] = useState('5000')
  const [lastRunAt, setLastRunAt] = useState<string | null>(null)

  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    api
      .getAnalysisSchedule()
      .then(({ schedule }) => {
        if (cancelled || !schedule) return

        setEnabled(schedule.enabled)
        setCadence(schedule.cadence)
        setHour(`${utcMinutesToLocalHour(schedule.minuteUtc)}`)
        setAccountId(schedule.accountId ?? '')
        setScanLimit(`${schedule.scanLimit}`)
        setLastRunAt(schedule.lastRunAt ?? null)
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  async function save(nextEnabled: boolean) {
    setSaving(true)
    setError(null)
    setNotice(null)

    const schedule: Omit<AnalysisSchedule, 'lastRunAt'> = {
      enabled: nextEnabled,
      cadence,
      minuteUtc: localHourToUtcMinutes(Number(hour)),
      accountId: accountId || null,
      // Spam excluded, the same as a manual run: it is Gmail's own rubbish
      // pile and leaving it in makes every sender chart a chart of spam.
      query: '-in:spam',
      scanLimit: Number(scanLimit),
      filters: { accountId, scanLimit },
    }

    try {
      await api.setAnalysisSchedule(schedule)
      setEnabled(nextEnabled)
      setNotice(
        nextEnabled
          ? 'Saved. The next run happens at the chosen hour.'
          : 'Scheduled analysis paused.',
      )
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError
          ? caught.message
          : 'Could not save that schedule.',
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="card">
      <div className="card__head">
        <h2>
          <ChartIcon size={17} />
          Scheduled analysis
        </h2>
      </div>

      <p className="hint">
        Runs a mailbox analysis on its own and stores the result, so it is
        already waiting the next time you open Hive. It only counts — clearing
        mail always needs you to press the button and confirm.
      </p>

      {loading ? (
        <p className="hint">Loading…</p>
      ) : (
        <>
          <div className="schedule__row">
            {accounts.length > 1 && (
              <Select
                label="Account to analyse"
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
              label="How often"
              value={cadence}
              options={CADENCES}
              onChange={setCadence}
            />

            <Select label="At" value={hour} options={HOURS} onChange={setHour} />

            <Select
              label="How deep"
              value={scanLimit}
              options={DEPTHS}
              onChange={setScanLimit}
            />
          </div>

          {/*
            Said plainly, because the cost is the whole reason this feature
            exists and the hour someone picks should account for it.
          */}
          <p className="hint">
            Reading who sent a message costs one Gmail request per message, so
            a deep scan takes a while and uses the same allowance the app needs
            while you are using it. A quiet hour is the right hour.
          </p>

          {lastRunAt && (
            <p className="hint">Last scheduled run {formatWhen(lastRunAt)}.</p>
          )}

          <div className="schedule__actions">
            <button type="button" disabled={saving} onClick={() => void save(true)}>
              {saving ? 'Saving…' : enabled ? 'Save changes' : 'Turn on'}
            </button>

            {enabled && (
              <button
                type="button"
                className="btn-quiet"
                disabled={saving}
                onClick={() => void save(false)}
              >
                Pause
              </button>
            )}
          </div>
        </>
      )}

      <div role="status" aria-live="polite">
        {notice && <p className="notice">{notice}</p>}
      </div>
      <div role="alert" aria-live="assertive">
        {error && <p className="bad">{error}</p>}
      </div>
    </section>
  )
}

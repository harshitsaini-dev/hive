import { useState } from 'react'
import type { ConnectedAccount } from '@hive/shared-types'
import { api, ApiRequestError } from './api.js'
import { AlertIcon, CheckIcon, PlusIcon, ScheduleIcon } from './Icons.js'
import {
  buildQuery,
  EMPTY_FILTERS,
  hasAnyFilter,
  MailFilters,
  type Filters,
} from './MailFilters.js'

/**
 * Building a cleanup rule, one decision at a time.
 *
 * The previous form asked for a Gmail query in a text box and then saved
 * whatever was typed. That is a bad way to create something that will delete
 * mail unattended on a schedule: nobody can tell from `older_than:30d` alone
 * whether it matches twelve messages or twelve thousand.
 *
 * So the middle step is a real count from the server, fetched before the rule
 * can be saved. Seeing "this matches 4,182 messages" is what turns a guess
 * into a decision.
 */

type Step = 'what' | 'check' | 'when'

const SCHEDULES = [
  { value: 'manual', label: 'Only when I run it', hint: 'Nothing happens on its own.' },
  { value: 'daily', label: 'Every day', hint: 'Runs once a day from now on.' },
  { value: 'weekly', label: 'Every week', hint: 'Runs once a week from now on.' },
] as const

export function RulesWizard({
  accounts,
  onCreated,
}: {
  accounts: ConnectedAccount[]
  onCreated: () => Promise<void> | void
}) {
  const [step, setStep] = useState<Step>('what')
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '')
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [schedule, setSchedule] =
    useState<(typeof SCHEDULES)[number]['value']>('manual')
  const [match, setMatch] = useState<{ count: number; truncated: boolean } | null>(
    null,
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const query = buildQuery(filters)
  const accountName =
    accounts.find((account) => account.id === accountId)?.gmailAddress ?? ''

  function restart() {
    setStep('what')
    setFilters(EMPTY_FILTERS)
    setSchedule('manual')
    setMatch(null)
    setError(null)
  }

  /** Step two: ask the server what this actually matches, right now. */
  async function check() {
    setBusy(true)
    setError(null)

    try {
      // Exclude the bin, exactly as the runner does, so the number shown is
      // the number the rule would act on rather than an inflated one.
      const result = await api.resolveQuery(accountId, `${query} -in:trash`)
      setMatch({ count: result.count, truncated: result.truncated })
      setStep('check')
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError
          ? caught.message
          : 'Could not check how many messages match.',
      )
    } finally {
      setBusy(false)
    }
  }

  async function save() {
    setBusy(true)
    setError(null)

    try {
      await api.createRule({ accountId, query, schedule })
      await onCreated()
      restart()
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError
          ? caught.message
          : 'Could not save that rule.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card wizard">
      <div className="card__head">
        <h2>
          <ScheduleIcon size={17} />
          New cleanup rule
        </h2>
        <ol className="wizard__steps" aria-label="Progress">
          {(['what', 'check', 'when'] as const).map((id, index) => (
            <li key={id} data-state={step === id ? 'current' : undefined}>
              <span>{index + 1}</span>
              {id === 'what' ? 'Choose mail' : id === 'check' ? 'Check' : 'Schedule'}
            </li>
          ))}
        </ol>
      </div>

      {step === 'what' && (
        <>
          <p className="hint">
            Pick the mail this rule should clear. It always moves matches to
            Trash — rules can never delete permanently.
          </p>

          {accounts.length > 1 && (
            <>
              <label htmlFor="wizard-account">Account</label>
              <select
                id="wizard-account"
                value={accountId}
                onChange={(event) => setAccountId(event.target.value)}
              >
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.gmailAddress}
                  </option>
                ))}
              </select>
            </>
          )}

          <MailFilters
            filters={filters}
            onChange={setFilters}
            onApply={() => void check()}
            onClear={() => setFilters(EMPTY_FILTERS)}
            submitLabel="Check what this matches"
          />

          {/*
            A rule with no filter would trash the entire mailbox on a
            schedule. The server refuses it too; this just says so earlier.
          */}
          {!hasAnyFilter(filters) && (
            <p className="hint">
              Choose at least one filter. A rule with nothing set would match
              every message in the account.
            </p>
          )}
        </>
      )}

      {step === 'check' && match && (
        <>
          <div className={match.count === 0 ? 'wizard__count' : 'wizard__count wizard__count--live'}>
            <strong>{match.count.toLocaleString()}</strong>
            <span>
              message{match.count === 1 ? '' : 's'} in {accountName} match right
              now
            </span>
          </div>

          <p className="hint">
            Matching: <code>{query}</code>
          </p>

          {match.truncated && (
            <p className="mailbox__truncated">
              <AlertIcon size={15} />
              More than this matched — the rule works through them in batches
              across runs.
            </p>
          )}

          {match.count === 0 && (
            <p className="hint">
              Nothing matches today. The rule will still catch mail that
              matches later, which is often the point.
            </p>
          )}

          <div className="wizard__actions">
            <button type="button" className="link" onClick={() => setStep('what')}>
              Change the filters
            </button>
            <button type="button" onClick={() => setStep('when')}>
              Looks right — continue
            </button>
          </div>
        </>
      )}

      {step === 'when' && (
        <>
          <p className="hint">How often should this run?</p>

          <div className="wizard__schedules">
            {SCHEDULES.map((option) => (
              <label key={option.value} className="radioline">
                <input
                  type="radio"
                  name="wizard-schedule"
                  value={option.value}
                  checked={schedule === option.value}
                  onChange={() => setSchedule(option.value)}
                />
                <span>
                  <strong>{option.label}</strong>
                  <span className="hint">{option.hint}</span>
                </span>
              </label>
            ))}
          </div>

          <div className="wizard__summary">
            <CheckIcon size={16} />
            <span>
              Move matches of <code>{query}</code> in <strong>{accountName}</strong>{' '}
              to Trash,{' '}
              {schedule === 'manual'
                ? 'when you run it'
                : schedule === 'daily'
                  ? 'every day'
                  : 'every week'}
              .
            </span>
          </div>

          <div className="wizard__actions">
            <button type="button" className="link" onClick={() => setStep('check')}>
              Back
            </button>
            <button
              type="button"
              className="icon-btn"
              disabled={busy}
              onClick={() => void save()}
            >
              <PlusIcon size={16} />
              {busy ? 'Saving…' : 'Save rule'}
            </button>
          </div>
        </>
      )}

      <div role="alert" aria-live="assertive">
        {error && <p className="bad">{error}</p>}
      </div>

      {busy && step === 'what' && <p className="hint">Counting…</p>}
    </section>
  )
}


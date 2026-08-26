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
import { AccountPicker } from './AccountPicker.js'
import { SenderPicker } from './SenderPicker.js'

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
  /**
   * The mailboxes this rule covers.
   *
   * A rule row holds one account, so choosing several saves several rules —
   * one per mailbox, each running on its own. That is honest about what
   * happens and it keeps the runner, the audit trail and "pause this one"
   * exactly as they were.
   */
  const [accountIds, setAccountIds] = useState<string[]>(
    accounts[0] ? [accounts[0].id] : [],
  )
  /** Senders this rule should clear, chosen rather than typed. */
  const [senders, setSenders] = useState<string[]>([])
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [schedule, setSchedule] =
    useState<(typeof SCHEDULES)[number]['value']>('manual')
  const [match, setMatch] = useState<{ count: number; truncated: boolean } | null>(
    null,
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /*
   * Senders join the filters as one `from:(a OR b)` clause rather than as
   * separate rules: it is one query Gmail can answer, and one number the
   * check step can show.
   */
  const query = [
    buildQuery(filters),
    senders.length === 1
      ? `from:${senders[0]}`
      : senders.length > 1
        ? `from:(${senders.join(' OR ')})`
        : '',
  ]
    .filter(Boolean)
    .join(' ')

  const chosen = accounts.filter((account) => accountIds.includes(account.id))
  const accountName =
    chosen.length === 1
      ? (chosen[0]?.gmailAddress ?? '')
      : `${chosen.length} mailboxes`

  const hasCondition = hasAnyFilter(filters) || senders.length > 0
  /*
   * Unticking every mailbox is reachable now that there is a button which
   * ticks them all. Without this the wizard would walk through the whole
   * flow and then save nothing at all, silently — the loop below simply has
   * no accounts to run over.
   */
  const hasMailbox = chosen.length > 0

  function restart() {
    setStep('what')
    setFilters(EMPTY_FILTERS)
    setSenders([])
    setSchedule('manual')
    setMatch(null)
    setError(null)
  }

  /** Step two: ask the server what this actually matches, right now. */
  async function check() {
    if (!hasMailbox) {
      setError('Choose at least one mailbox for this rule to run in.')
      return
    }

    setBusy(true)
    setError(null)

    try {
      // Exclude the bin, exactly as the runner does, so the number shown is
      // the number the rule would act on rather than an inflated one.
      /*
       * Every chosen mailbox, added up. One number for a rule that will run
       * in several places is the only figure that answers "what will this
       * clear" — a count from the first account would understate it silently.
       */
      const results = await Promise.all(
        chosen.map((account) =>
          api.resolveQuery(account.id, `${query} -in:trash`),
        ),
      )

      setMatch({
        count: results.reduce((sum, result) => sum + result.count, 0),
        truncated: results.some((result) => result.truncated),
      })
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
      // One rule per mailbox: the row holds a single account, and a rule that
      // is really several should be several — pausable and auditable apiece.
      for (const account of chosen) {
        await api.createRule({ accountId: account.id, query, schedule })
      }
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
              <span className="formlabel">Mailboxes</span>
              <AccountPicker
                label="Mailboxes this rule covers"
                accounts={accounts}
                selected={accountIds}
                onChange={setAccountIds}
                requireOne
              />
            </>
          )}

          <span className="formlabel">Senders</span>
          <SenderPicker accountIds={accountIds} selected={senders} onChange={setSenders} />

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
          {!hasCondition && (
            <p className="hint">
              Choose at least one filter or sender. A rule with nothing set
              would match every message in the mailbox.
            </p>
          )}

          {!hasMailbox && (
            <p className="hint">
              Choose at least one mailbox for this rule to run in.
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


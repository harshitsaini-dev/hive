import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { ConnectedAccount } from '@hive/shared-types'
import { api, ApiRequestError, type CleanupRule } from './api.js'
import { PlusIcon, ScheduleIcon, TrashIcon } from './Icons.js'

const SCHEDULES = [
  { value: 'manual', label: 'Only when I run it' },
  { value: 'daily', label: 'Every day' },
  { value: 'weekly', label: 'Every week' },
] as const

const EXAMPLES = [
  'category:promotions older_than:30d',
  'from:noreply@ older_than:90d',
  'is:unread older_than:1y',
]

export function RulesPanel({ accounts }: { accounts: ConnectedAccount[] }) {
  const [rules, setRules] = useState<CleanupRule[] | null>(null)
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '')
  const [query, setQuery] = useState('')
  const [schedule, setSchedule] = useState<'manual' | 'daily' | 'weekly'>('manual')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setRules((await api.listRules()).rules)
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError ? caught.message : 'Could not load rules.',
      )
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function create(event: FormEvent) {
    event.preventDefault()
    setBusy('create')
    setError(null)

    try {
      await api.createRule({ accountId, query: query.trim(), schedule })
      setQuery('')
      await refresh()
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError ? caught.message : 'Could not save that rule.',
      )
    } finally {
      setBusy(null)
    }
  }

  async function act(id: string, work: () => Promise<void>) {
    setBusy(id)
    setError(null)
    try {
      await work()
      await refresh()
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError ? caught.message : 'That did not work.',
      )
    } finally {
      setBusy(null)
    }
  }

  const accountName = (id: string) =>
    accounts.find((account) => account.id === id)?.gmailAddress ?? 'unknown account'

  return (
    <section className="card rules">
      <div className="card__head">
        <h2>
          <ScheduleIcon size={17} />
          Cleanup rules
        </h2>
      </div>

      {/*
        Stated plainly, because a rule runs unattended and people should know
        exactly how far it can go. Rules can only trash — see ADR 0002.
      */}
      <p className="hint">
        A saved search that runs on a schedule and moves matches to Trash. Rules
        never delete permanently, so anything a rule touches is recoverable for
        thirty days.
      </p>

      <form className="rules__form" onSubmit={create}>
        <div className="rules__row">
          <label htmlFor="rule-account" className="sr-only">
            Account
          </label>
          <select
            id="rule-account"
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
          >
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.gmailAddress}
              </option>
            ))}
          </select>

          <label htmlFor="rule-schedule" className="sr-only">
            Schedule
          </label>
          <select
            id="rule-schedule"
            value={schedule}
            onChange={(event) =>
              setSchedule(event.target.value as typeof schedule)
            }
          >
            {SCHEDULES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <label htmlFor="rule-query">Search to match</label>
        <input
          id="rule-query"
          value={query}
          placeholder="category:promotions older_than:30d"
          onChange={(event) => setQuery(event.target.value)}
        />

        <div className="rules__examples">
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              className="chip"
              onClick={() => setQuery(example)}
            >
              {example}
            </button>
          ))}
        </div>

        <button
          type="submit"
          className="icon-btn"
          disabled={busy === 'create' || query.trim().length < 3 || !accountId}
        >
          <PlusIcon size={16} />
          {busy === 'create' ? 'Saving…' : 'Save rule'}
        </button>
      </form>

      <div role="status" aria-live="polite">
        {notice && <p className="notice">{notice}</p>}
      </div>

      {rules === null && <p className="hint">Loading rules…</p>}

      {rules?.length === 0 && (
        <p className="hint">No rules yet. Save one above to automate a cleanup.</p>
      )}

      {rules && rules.length > 0 && (
        <ul className="rules__list">
          {rules.map((rule) => (
            <li key={rule.id} data-enabled={rule.enabled}>
              <div className="rules__meta">
                <code>{rule.query}</code>
                <span className="hint">
                  {accountName(rule.accountId)} ·{' '}
                  {SCHEDULES.find((s) => s.value === rule.schedule)?.label}
                  {rule.lastRunAt
                    ? ` · last run ${new Date(rule.lastRunAt + 'Z').toLocaleString()}`
                    : ' · never run'}
                  {!rule.enabled && ' · paused'}
                </span>
              </div>

              <div className="rules__actions">
                <button
                  type="button"
                  className="btn-outline"
                  disabled={busy === rule.id}
                  onClick={() =>
                    void act(rule.id, async () => {
                      const result = await api.runRule(rule.id)
                      setNotice(
                        result.trashed === 0
                          ? 'Nothing matched that rule.'
                          : `Moved ${result.trashed} message${result.trashed === 1 ? '' : 's'} to Trash${result.truncated ? ' (hit the per-run limit)' : ''}.`,
                      )
                    })
                  }
                >
                  {busy === rule.id ? 'Running…' : 'Run now'}
                </button>

                <button
                  type="button"
                  className="link"
                  disabled={busy === rule.id}
                  onClick={() =>
                    void act(rule.id, () =>
                      api.setRuleEnabled(rule.id, !rule.enabled),
                    )
                  }
                >
                  {rule.enabled ? 'Pause' : 'Resume'}
                </button>

                <button
                  type="button"
                  className="link icon-btn"
                  disabled={busy === rule.id}
                  onClick={() => {
                    if (!window.confirm(`Delete the rule "${rule.query}"?`)) return
                    void act(rule.id, () => api.deleteRule(rule.id))
                  }}
                >
                  <TrashIcon size={14} />
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div role="alert" aria-live="assertive">
        {error && <p className="bad">{error}</p>}
      </div>
    </section>
  )
}

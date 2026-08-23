import { useCallback, useEffect, useState } from 'react'
import type { ConnectedAccount } from '@hive/shared-types'
import { api, ApiRequestError, type CleanupRule } from './api.js'
import { ConfirmDialog } from './ConfirmDialog.js'
import { TrashIcon } from './Icons.js'
import { RulesWizard } from './RulesWizard.js'

const SCHEDULES = [
  { value: 'manual', label: 'Only when I run it' },
  { value: 'daily', label: 'Every day' },
  { value: 'weekly', label: 'Every week' },
] as const

export function RulesPanel({ accounts }: { accounts: ConnectedAccount[] }) {
  const [rules, setRules] = useState<CleanupRule[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /** The rule awaiting confirmation before it is deleted. */
  const [pendingDelete, setPendingDelete] = useState<CleanupRule | null>(null)

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
    <section className="rules">
      {/*
        Stated plainly, because a rule runs unattended and people should know
        exactly how far it can go. Rules can only trash — see ADR 0002.
      */}
      <p className="hint">
        A saved search that runs on a schedule and moves matches to Trash. Rules
        never delete permanently, so anything a rule touches is recoverable for
        thirty days.
      </p>

      <RulesWizard accounts={accounts} onCreated={refresh} />

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
                  onClick={() => setPendingDelete(rule)}
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

      {pendingDelete && (
        <ConfirmDialog
          title="Delete this cleanup rule?"
          body={`The rule matching "${pendingDelete.query}" stops running. Mail it has already moved to Trash stays there.`}
          confirmLabel="Delete rule"
          busy={busy === pendingDelete.id}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            const id = pendingDelete.id
            setPendingDelete(null)
            void act(id, () => api.deleteRule(id))
          }}
        />
      )}
    </section>
  )
}

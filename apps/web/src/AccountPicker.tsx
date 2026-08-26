import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ConnectedAccount } from '@hive/shared-types'
import { ChevronDownIcon, SearchIcon } from './Icons.js'

/**
 * Choosing mailboxes, when there are forty of them.
 *
 * The plain {@link Select} was fine at three accounts and useless at forty: a
 * list you scroll blindly, one choice at a time, when the actual question is
 * usually "these five" or "everything except that one". So this searches, and
 * it takes more than one answer.
 *
 * An empty selection means *all of them*, which is the same convention the
 * rest of the app already uses for an unset account filter — and it keeps the
 * common case a single glance rather than forty ticks.
 */
export function AccountPicker({
  accounts,
  selected,
  onChange,
  label = 'Accounts',
  className,
  /** Refuse an empty selection, where "all" is not a sensible answer. */
  requireOne = false,
  counts,
  allCount,
}: {
  accounts: ConnectedAccount[]
  /** Empty means every account. */
  selected: string[]
  onChange: (next: string[]) => void
  label?: string
  className?: string
  requireOne?: boolean
  /**
   * How much mail each mailbox holds, by account id.
   *
   * Where the picker narrows a result rather than setting a scope, the size
   * of each mailbox is half the reason for choosing one — the row that says
   * 1,588 is the row worth opening.
   */
  counts?: Record<string, number>
  /**
   * What "all accounts" holds, when that is known separately.
   *
   * Summing the per-mailbox counts would usually agree, and where it does not
   * the picker would be quietly contradicting the headline figure directly
   * above it — two totals disagreeing side by side is a bug whichever one is
   * right.
   */
  allCount?: number
}) {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const panelId = useId()

  // Opening should start from a clean search, not from last time's.
  useEffect(() => {
    if (!open) return
    setFilter('')
    search.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return

    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (!needle) return accounts
    return accounts.filter((account) =>
      account.gmailAddress.toLowerCase().includes(needle),
    )
  }, [accounts, filter])

  const chosen = new Set(selected)
  const everyChosen =
    accounts.length > 0 && accounts.every((account) => chosen.has(account.id))

  /*
   * What the closed control says.
   *
   * A count rather than a list of addresses: three of these will not fit, and
   * a truncated list of mailboxes is worse than a number, because it looks
   * like the whole answer.
   */
  const summary =
    chosen.size === 0
      ? requireOne
        ? 'Choose a mailbox'
        : 'All accounts'
      : chosen.size === 1
        ? (accounts.find((account) => chosen.has(account.id))?.gmailAddress ??
          '1 account')
        : everyChosen
          ? `All ${accounts.length} accounts`
          : `${chosen.size} accounts`

  function toggle(id: string) {
    const next = new Set(chosen)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange([...next])
  }

  return (
    <div
      ref={root}
      className={className ? `picker ${className}` : 'picker'}
    >
      <button
        type="button"
        className="picker__button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={label}
        onClick={() => setOpen(!open)}
      >
        <span className="picker__value">{summary}</span>
        <ChevronDownIcon size={15} />
      </button>

      {open && (
        <div id={panelId} className="picker__panel" role="dialog" aria-label={label}>
          <div className="search-field picker__search">
            <SearchIcon size={14} />
            <label htmlFor={`${panelId}-search`} className="sr-only">
              Find a mailbox
            </label>
            <input
              id={`${panelId}-search`}
              ref={search}
              type="search"
              value={filter}
              placeholder="Find a mailbox"
              onChange={(event) => setFilter(event.target.value)}
            />
          </div>

          {/*
            Where "all" is the absence of a choice, clearing is how you say it
            — one click from anywhere in the list, rather than forty ticks.
          */}
          {!requireOne && (
            <button
              type="button"
              className="picker__all"
              aria-pressed={chosen.size === 0}
              onClick={() => onChange([])}
            >
              All accounts
              {(allCount !== undefined || counts) && (
                <span className="hint picker__count">
                  {(
                    allCount ??
                    Object.values(counts ?? {}).reduce(
                      (sum, count) => sum + count,
                      0,
                    )
                  ).toLocaleString()}
                </span>
              )}
            </button>
          )}

          {/*
            Where it is not, "all" has to be forty actual ticks — so here is
            the one button that does them. Without it a rule for every mailbox
            could only be built by hand, forty times, which is exactly the
            work this control exists to remove.

            It turns into its own undo once everything is on, because a list
            with every box ticked and no way back is a trap.
          */}
          {requireOne && accounts.length > 1 && (
            <button
              type="button"
              className="picker__all"
              onClick={() =>
                onChange(
                  everyChosen ? [] : accounts.map((account) => account.id),
                )
              }
            >
              {everyChosen
                ? 'Clear the selection'
                : `Select all ${accounts.length}`}
            </button>
          )}

          {shown.length === 0 ? (
            <p className="hint picker__empty">No mailbox matches “{filter}”.</p>
          ) : (
            <ul className="picker__list">
              {shown.map((account) => (
                <li key={account.id}>
                  <label className="checkline picker__option">
                    <input
                      type="checkbox"
                      checked={chosen.has(account.id)}
                      onChange={() => toggle(account.id)}
                    />
                    <span>{account.gmailAddress}</span>
                    {counts && (
                      <span className="hint picker__count">
                        {(counts[account.id] ?? 0).toLocaleString()}
                      </span>
                    )}
                  </label>
                </li>
              ))}
            </ul>
          )}

          {/*
            Only the ones matching the search, which is what makes it useful:
            type "rajmandir.r", take all nine, close.
          */}
          {filter.trim() !== '' && shown.length > 0 && (
            <div className="picker__foot">
              <button
                type="button"
                className="btn-quiet"
                onClick={() =>
                  onChange([
                    ...new Set([...chosen, ...shown.map((a) => a.id)]),
                  ])
                }
              >
                Add these {shown.length}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { api } from './api.js'
import { ChevronDownIcon, SearchIcon } from './Icons.js'

/**
 * Choosing senders for a cleanup rule.
 *
 * Deliberately a list to pick from rather than a box to type into. "Clear
 * everything from these five" is the rule people actually want, and typing
 * five addresses from memory is how one of them ends up wrong — a rule that
 * runs weekly against a query with a typo in it does nothing, silently, for
 * ever.
 *
 * The list comes from the local index, which is the only reason it can exist:
 * the same question asked of Gmail is a metadata read per message.
 */
export function SenderPicker({
  accountIds,
  selected,
  onChange,
}: {
  /** Whose senders to offer. Empty means every connected account. */
  accountIds: string[]
  selected: string[]
  onChange: (next: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [senders, setSenders] = useState<
    { address: string; count: number }[] | null
  >(null)
  const [failed, setFailed] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const panelId = useId()

  const key = accountIds.join(',')

  /*
   * Fetched when the panel first opens, not on mount.
   *
   * A rule form that queries every mailbox's senders before anyone has asked
   * for one is work done on the chance it is wanted.
   */
  useEffect(() => {
    if (!open) return

    setFilter('')
    search.current?.focus()
    if (senders !== null) return

    let cancelled = false
    api
      .listSenders(accountIds)
      .then((result) => {
        if (!cancelled) setSenders(result.senders)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, key])

  // Changing the mailboxes changes who has written to them.
  useEffect(() => {
    setSenders(null)
    setFailed(false)
  }, [key])

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
    const all = senders ?? []
    return needle
      ? all.filter((sender) => sender.address.toLowerCase().includes(needle))
      : all
  }, [senders, filter])

  const chosen = new Set(selected)

  const summary =
    chosen.size === 0
      ? 'Any sender'
      : chosen.size === 1
        ? [...chosen][0]!
        : `${chosen.size} senders`

  function toggle(address: string) {
    const next = new Set(chosen)
    if (next.has(address)) next.delete(address)
    else next.add(address)
    onChange([...next])
  }

  return (
    <div ref={root} className="picker">
      <button
        type="button"
        className="picker__button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Senders this rule covers"
        onClick={() => setOpen(!open)}
      >
        <span className="picker__value">{summary}</span>
        <ChevronDownIcon size={15} />
      </button>

      {open && (
        <div
          id={panelId}
          className="picker__panel"
          role="dialog"
          aria-label="Senders this rule covers"
        >
          <div className="search-field picker__search">
            <SearchIcon size={14} />
            <label htmlFor={`${panelId}-search`} className="sr-only">
              Find a sender
            </label>
            <input
              id={`${panelId}-search`}
              ref={search}
              type="search"
              value={filter}
              placeholder="Find a sender"
              onChange={(event) => setFilter(event.target.value)}
            />
          </div>

          {chosen.size > 0 && (
            <button
              type="button"
              className="picker__all"
              onClick={() => onChange([])}
            >
              Clear {chosen.size} chosen
            </button>
          )}

          {failed ? (
            <p className="hint picker__empty">
              Could not read the sender list. The rule still works if you set
              filters instead.
            </p>
          ) : senders === null ? (
            <p className="hint picker__empty">Reading the index…</p>
          ) : shown.length === 0 ? (
            <p className="hint picker__empty">
              {senders.length === 0
                ? 'Nothing indexed for these mailboxes yet — indexing fills this in on its own.'
                : `No sender matches “${filter}”.`}
            </p>
          ) : (
            <ul className="picker__list">
              {/*
                Capped at what a person will scroll. The search is how you
                reach the rest, and it runs over all of them.
              */}
              {shown.slice(0, 200).map((sender) => (
                <li key={sender.address}>
                  <label className="checkline picker__option">
                    <input
                      type="checkbox"
                      checked={chosen.has(sender.address)}
                      onChange={() => toggle(sender.address)}
                    />
                    <span>{sender.address}</span>
                    <span className="hint picker__count">
                      {sender.count.toLocaleString()}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

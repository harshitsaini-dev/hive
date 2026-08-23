import { useState } from 'react'
import type { StructuredSearch } from './api.js'
import { DatePicker } from './DatePicker.js'
import { SearchIcon } from './Icons.js'
import { Select } from './Select.js'

/**
 * The filter controls, and the Gmail query they compile to.
 *
 * The search box used to accept raw Gmail syntax and nothing else, with a line
 * of documentation under it. That is fine if you already know the syntax and
 * useless if you do not — and "clean out old promotions" should not require
 * learning a query language. These controls cover what people actually filter
 * by; the raw box is still there for anyone who wants it.
 */

export interface Filters {
  text: string
  from: string
  olderThan: '' | '7d' | '30d' | '90d' | '1y'
  category: '' | 'promotions' | 'social' | 'updates' | 'forums'
  /** Inclusive start of a custom date range, as `YYYY-MM-DD`. */
  after: string
  /** Inclusive end of a custom date range, as `YYYY-MM-DD`. */
  before: string
  hasAttachment: boolean
  unreadOnly: boolean
  /** Raw Gmail syntax, appended verbatim. Empty unless the user opts in. */
  raw: string
}

export const EMPTY_FILTERS: Filters = {
  text: '',
  from: '',
  olderThan: '',
  category: '',
  after: '',
  before: '',
  hasAttachment: false,
  unreadOnly: false,
  raw: '',
}

export function hasAnyFilter(filters: Filters): boolean {
  return (
    filters.text.trim() !== '' ||
    filters.from.trim() !== '' ||
    filters.olderThan !== '' ||
    filters.category !== '' ||
    filters.after !== '' ||
    filters.before !== '' ||
    filters.hasAttachment ||
    filters.unreadOnly ||
    filters.raw.trim() !== ''
  )
}

/** `2026-01-31` -> `2026/02/01`, so an inclusive end date reads as one. */
function nextDay(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return isoDate.replace(/-/g, '/')

  date.setUTCDate(date.getUTCDate() + 1)
  const month = `${date.getUTCMonth() + 1}`.padStart(2, '0')
  const day = `${date.getUTCDate()}`.padStart(2, '0')
  return `${date.getUTCFullYear()}/${month}/${day}`
}

/**
 * Compiles the filters into Gmail search syntax.
 *
 * Free text is quoted when it contains spaces so a phrase stays a phrase;
 * without that, `holiday photos` silently becomes two separate terms.
 */
export function buildQuery(filters: Filters): string {
  const parts: string[] = []

  const text = filters.text.trim()
  if (text) parts.push(/\s/.test(text) ? `"${text.replace(/"/g, '')}"` : text)

  const from = filters.from.trim()
  if (from) parts.push(`from:${from}`)

  if (filters.olderThan) parts.push(`older_than:${filters.olderThan}`)

  /*
   * Gmail wants `YYYY/MM/DD`, the date input gives `YYYY-MM-DD`, and `before:`
   * is exclusive of the day named. A range picked as 1–31 January that quietly
   * stopped on the 30th would be a filter that lies, so the end date is pushed
   * out by a day to make it mean what the field says.
   */
  if (filters.after) parts.push(`after:${filters.after.replace(/-/g, '/')}`)
  if (filters.before) parts.push(`before:${nextDay(filters.before)}`)
  if (filters.category) parts.push(`category:${filters.category}`)
  if (filters.hasAttachment) parts.push('has:attachment')
  if (filters.unreadOnly) parts.push('is:unread')

  const raw = filters.raw.trim()
  if (raw) parts.push(raw)

  return parts.join(' ')
}

const OLDER_DAYS: Record<string, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  '1y': 365,
}

/**
 * The same filters, in the shape the local index can query.
 *
 * Returns null when the query cannot be answered locally, which means free
 * text or raw Gmail syntax. Gmail searches message bodies; the index holds
 * sender, subject and a snippet, because storing bodies is what the privacy
 * policy forbids. A text search that quietly stopped matching words inside
 * messages would be a worse product wearing a faster one's clothes.
 */
export function toStructured(
  filters: Filters,
  folder: 'inbox' | 'sent' | 'trash' | 'all',
): StructuredSearch | null {
  if (filters.text.trim() || filters.raw.trim()) return null

  return {
    folder,
    ...(filters.from.trim() ? { from: filters.from.trim() } : {}),
    ...(filters.after ? { after: filters.after } : {}),
    // Exclusive on the server, and the field means an inclusive day — the
    // same correction `buildQuery` makes for Gmail's `before:`.
    ...(filters.before ? { before: nextDayIso(filters.before) } : {}),
    ...(filters.olderThan
      ? { olderThanDays: OLDER_DAYS[filters.olderThan] }
      : {}),
    ...(filters.category ? { category: filters.category } : {}),
    ...(filters.hasAttachment ? { hasAttachment: true } : {}),
    ...(filters.unreadOnly ? { unreadOnly: true } : {}),
  }
}

/** `2026-01-31` -> `2026-02-01`, keeping an inclusive end date inclusive. */
function nextDayIso(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return isoDate

  date.setUTCDate(date.getUTCDate() + 1)
  return date.toISOString().slice(0, 10)
}

const OLDER_THAN = [
  { value: '', label: 'Any age' },
  { value: '7d', label: 'Older than a week' },
  { value: '30d', label: 'Older than a month' },
  { value: '90d', label: 'Older than 3 months' },
  { value: '1y', label: 'Older than a year' },
] as const

const CATEGORIES = [
  { value: '', label: 'All mail' },
  { value: 'promotions', label: 'Promotions' },
  { value: 'social', label: 'Social' },
  { value: 'updates', label: 'Updates' },
  { value: 'forums', label: 'Forums' },
] as const

export function MailFilters({
  filters,
  onChange,
  onApply,
  onClear,
  submitLabel = 'Search',
}: {
  filters: Filters
  onChange: (filters: Filters) => void
  onApply: () => void
  onClear: () => void
  /** The same controls serve searching and rule-building; only the verb differs. */
  submitLabel?: string
}) {
  const [showRaw, setShowRaw] = useState(filters.raw !== '')

  /*
   * Collapsed on a phone, open on a desktop.
   *
   * Eight controls stacked one per line filled an entire phone screen before
   * a single message was visible — the filters became the page and the mail
   * became something below it. On a desktop they sit in two or three rows and
   * cost nothing, so the default follows the width rather than being a
   * preference nobody asked to express.
   */
  const [open, setOpen] = useState(
    () => window.matchMedia('(min-width: 48rem)').matches,
  )
  const set = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    onChange({ ...filters, [key]: value })

  const compiled = buildQuery(filters)

  /*
   * How many of the hidden controls are actually set. Collapsing them is only
   * safe if a collapsed panel cannot hide a filter that is silently shaping
   * the results — the free-text box stays visible, so it is excluded.
   */
  const activeCount = [
    filters.from.trim() !== '',
    filters.olderThan !== '',
    filters.category !== '',
    filters.after !== '',
    filters.before !== '',
    filters.hasAttachment,
    filters.unreadOnly,
    filters.raw.trim() !== '',
  ].filter(Boolean).length

  return (
    <form
      className="filters"
      onSubmit={(event) => {
        event.preventDefault()
        onApply()
      }}
    >
      <div className="filters__row">
        <label htmlFor="f-text" className="sr-only">
          Search words
        </label>
        <div className="search-field">
          <SearchIcon size={16} />
          <input
            id="f-text"
            type="search"
            value={filters.text}
            placeholder="Search words in subject or body"
            onChange={(event) => set('text', event.target.value)}
          />
        </div>

        <button type="submit">{submitLabel}</button>

        {/*
          Only where the rest is hidden. On a desktop the controls are already
          on screen and a button to reveal them would be a button to do
          nothing.
        */}
        <button
          type="button"
          className="btn-quiet filters__toggle"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? 'Fewer filters' : 'More filters'}
          {!open && activeCount > 0 && (
            <span className="filters__badge">{activeCount}</span>
          )}
        </button>
      </div>

      <div className="filters__rest" data-open={open}>
      <div className="filters__row">
        <label htmlFor="f-from" className="sr-only">
          From
        </label>
        <input
          id="f-from"
          className="filters__from"
          value={filters.from}
          placeholder="From (name or address)"
          onChange={(event) => set('from', event.target.value)}
        />

        <Select
          id="f-age"
          label="Age"
          value={filters.olderThan}
          options={OLDER_THAN}
          onChange={(next) => set('olderThan', next)}
        />

        <Select
          id="f-category"
          label="Category"
          value={filters.category}
          options={CATEGORIES}
          onChange={(next) => set('category', next)}
        />
      </div>

      <div className="filters__row filters__row--dates">
        {/*
          A range, not another preset. "Older than a year" cannot express
          "that job I had in 2019", and telling someone to write
          `after:2019/01/01` in the raw box is telling them to learn Gmail's
          syntax to answer an ordinary question.
        */}
        <span className="formlabel">Between</span>

        <DatePicker
          label="Earliest date"
          placeholder="Any earlier date"
          value={filters.after}
          max={filters.before || undefined}
          onChange={(next) => set('after', next)}
        />

        <span className="hint">and</span>

        <DatePicker
          label="Latest date"
          placeholder="Any later date"
          value={filters.before}
          min={filters.after || undefined}
          onChange={(next) => set('before', next)}
        />

        {(filters.after || filters.before) && (
          <button
            type="button"
            className="btn-quiet"
            onClick={() => onChange({ ...filters, after: '', before: '' })}
          >
            Clear dates
          </button>
        )}
      </div>

      <div className="filters__row filters__row--toggles">
        <label className="checkline">
          <input
            type="checkbox"
            checked={filters.hasAttachment}
            onChange={(event) => set('hasAttachment', event.target.checked)}
          />
          Has attachment
        </label>

        <label className="checkline">
          <input
            type="checkbox"
            checked={filters.unreadOnly}
            onChange={(event) => set('unreadOnly', event.target.checked)}
          />
          Unread only
        </label>

        <button
          type="button"
          className="btn-quiet"
          onClick={() => setShowRaw(!showRaw)}
        >
          {showRaw ? 'Hide Gmail syntax' : 'Use Gmail syntax'}
        </button>

        {hasAnyFilter(filters) && (
          <button type="button" className="btn-quiet" onClick={onClear}>
            Clear filters
          </button>
        )}
      </div>

      {showRaw && (
        <div className="filters__raw">
          <label htmlFor="f-raw">Extra Gmail search terms</label>
          <input
            id="f-raw"
            value={filters.raw}
            placeholder="label:receipts -from:me larger:5M"
            onChange={(event) => set('raw', event.target.value)}
          />
          {/*
            Shown because the controls above are a lossy abstraction: seeing
            what they compile to is how someone learns the syntax, and how they
            check the filter means what they think.
          */}
          <p className="hint">
            Searching for: <code>{compiled || '(everything)'}</code>
          </p>
        </div>
      )}
      </div>
    </form>
  )
}

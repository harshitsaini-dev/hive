import { useState } from 'react'
import { SearchIcon } from './Icons.js'

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
    filters.hasAttachment ||
    filters.unreadOnly ||
    filters.raw.trim() !== ''
  )
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
  if (filters.category) parts.push(`category:${filters.category}`)
  if (filters.hasAttachment) parts.push('has:attachment')
  if (filters.unreadOnly) parts.push('is:unread')

  const raw = filters.raw.trim()
  if (raw) parts.push(raw)

  return parts.join(' ')
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
}: {
  filters: Filters
  onChange: (filters: Filters) => void
  onApply: () => void
  onClear: () => void
}) {
  const [showRaw, setShowRaw] = useState(filters.raw !== '')
  const set = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    onChange({ ...filters, [key]: value })

  const compiled = buildQuery(filters)

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

        <button type="submit">Search</button>
      </div>

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

        <label htmlFor="f-age" className="sr-only">
          Age
        </label>
        <select
          id="f-age"
          value={filters.olderThan}
          onChange={(event) =>
            set('olderThan', event.target.value as Filters['olderThan'])
          }
        >
          {OLDER_THAN.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <label htmlFor="f-category" className="sr-only">
          Category
        </label>
        <select
          id="f-category"
          value={filters.category}
          onChange={(event) =>
            set('category', event.target.value as Filters['category'])
          }
        >
          {CATEGORIES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
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
          className="link"
          onClick={() => setShowRaw(!showRaw)}
        >
          {showRaw ? 'Hide Gmail syntax' : 'Use Gmail syntax'}
        </button>

        {hasAnyFilter(filters) && (
          <button type="button" className="link" onClick={onClear}>
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
    </form>
  )
}

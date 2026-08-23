import { useEffect, useId, useRef, useState } from 'react'
import {
  CalendarIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from './Icons.js'
import { Select } from './Select.js'

/**
 * A date field that matches the rest of the app.
 *
 * Same reason as the dropdown next to it: `<input type="date">` styles its box
 * and nothing else. The calendar is drawn by the browser, in the browser's
 * colours, with the browser's idea of where the week starts — a pale panel
 * dropping out of a dark app, and a different pale panel on the next machine.
 *
 * Which sets the bar. Everything the native control gave away for free is
 * rebuilt here: arrow keys walk the grid a day at a time, PageUp and PageDown
 * change month, Home and End reach the ends of the week, Enter commits,
 * Escape closes without changing anything, and the grid carries the roles a
 * screen reader expects.
 *
 * Values are `YYYY-MM-DD` throughout, the same as the native element, so
 * nothing downstream has to know this component exists.
 */

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'] as const

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const

/**
 * Dates are held at UTC midnight and never converted to local time.
 *
 * A calendar day is not an instant. Building one with `new Date(y, m, d)` in
 * a negative-offset timezone and reading it back as an ISO string lands on the
 * day before, which is how date pickers end up off by one for half the world.
 */
function utcDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month, day))
}

function toValue(date: Date): string {
  const month = `${date.getUTCMonth() + 1}`.padStart(2, '0')
  const day = `${date.getUTCDate()}`.padStart(2, '0')
  return `${date.getUTCFullYear()}-${month}-${day}`
}

function parseValue(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isNaN(date.getTime()) ? null : date
}

function today(): Date {
  const now = new Date()
  return utcDate(now.getFullYear(), now.getMonth(), now.getDate())
}

/** `2019-03-21` -> `21 Mar 2019`. Unambiguous, unlike any all-digit form. */
function format(date: Date): string {
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]?.slice(0, 3)} ${date.getUTCFullYear()}`
}

/** The six-week grid a month is drawn in, Sunday first. */
function monthGrid(year: number, month: number): Date[] {
  const first = utcDate(year, month, 1)
  const start = utcDate(year, month, 1 - first.getUTCDay())

  return Array.from({ length: 42 }, (_, index) =>
    utcDate(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + index),
  )
}

function sameDay(a: Date, b: Date): boolean {
  return a.getTime() === b.getTime()
}

function clamp(date: Date, min: Date | null, max: Date | null): boolean {
  if (min && date.getTime() < min.getTime()) return false
  if (max && date.getTime() > max.getTime()) return false
  return true
}

export function DatePicker({
  label,
  value,
  onChange,
  min,
  max,
  placeholder = 'Any date',
}: {
  /** Accessible name — there is no visible label on the control itself. */
  label: string
  /** `YYYY-MM-DD`, or empty for no date. */
  value: string
  onChange: (value: string) => void
  min?: string
  max?: string
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  const selected = parseValue(value)
  const [cursor, setCursor] = useState<Date>(selected ?? today())
  const root = useRef<HTMLDivElement>(null)
  const grid = useRef<HTMLDivElement>(null)
  const gridId = useId()

  const minDate = min ? parseValue(min) : null
  const maxDate = max ? parseValue(max) : null

  // Opening should land on the chosen date, not wherever it was left last.
  useEffect(() => {
    if (open) setCursor(selected ?? today())
    // `selected` is derived from `value`; depending on it directly would move
    // the cursor back under the user's feet as they arrow around.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, value])

  useEffect(() => {
    if (!open) return

    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }

    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  // The grid takes focus so the arrow keys have somewhere to arrive.
  useEffect(() => {
    if (open) grid.current?.focus()
  }, [open])

  function commit(date: Date) {
    if (!clamp(date, minDate, maxDate)) return
    onChange(toValue(date))
    setOpen(false)
  }

  function move(days: number) {
    setCursor((current) =>
      utcDate(
        current.getUTCFullYear(),
        current.getUTCMonth(),
        current.getUTCDate() + days,
      ),
    )
  }

  function moveMonths(months: number) {
    setCursor((current) =>
      utcDate(
        current.getUTCFullYear(),
        current.getUTCMonth() + months,
        current.getUTCDate(),
      ),
    )
  }

  function onGridKeyDown(event: React.KeyboardEvent) {
    switch (event.key) {
      case 'Escape':
        event.preventDefault()
        setOpen(false)
        break
      case 'ArrowLeft':
        event.preventDefault()
        move(-1)
        break
      case 'ArrowRight':
        event.preventDefault()
        move(1)
        break
      case 'ArrowUp':
        event.preventDefault()
        move(-7)
        break
      case 'ArrowDown':
        event.preventDefault()
        move(7)
        break
      case 'Home':
        event.preventDefault()
        move(-cursor.getUTCDay())
        break
      case 'End':
        event.preventDefault()
        move(6 - cursor.getUTCDay())
        break
      case 'PageUp':
        event.preventDefault()
        moveMonths(-1)
        break
      case 'PageDown':
        event.preventDefault()
        moveMonths(1)
        break
      case 'Enter':
      case ' ':
        event.preventDefault()
        commit(cursor)
        break
      default:
        break
    }
  }

  const days = monthGrid(cursor.getUTCFullYear(), cursor.getUTCMonth())
  const now = today()

  /*
   * A span wide enough to cover a mailbox's history. Jumping from 2026 to
   * 2019 by clicking a chevron eighty-four times is not a date picker.
   */
  const years = Array.from({ length: 30 }, (_, index) => {
    const year = now.getUTCFullYear() - 25 + index
    return { value: `${year}`, label: `${year}` }
  })

  return (
    <div ref={root} className="datepicker">
      <button
        type="button"
        className="datepicker__button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen(!open)}
      >
        <CalendarIcon size={15} />
        <span
          className={selected ? 'datepicker__value' : 'datepicker__value hint'}
        >
          {selected ? format(selected) : placeholder}
        </span>
        <ChevronDownIcon size={14} />
      </button>

      {open && (
        <div className="datepicker__panel" role="dialog" aria-label={label}>
          <div className="datepicker__head">
            <button
              type="button"
              className="datepicker__nav"
              aria-label="Previous month"
              onClick={() => moveMonths(-1)}
            >
              <ChevronLeftIcon size={16} />
            </button>

            <Select
              label="Month"
              className="datepicker__select"
              value={`${cursor.getUTCMonth()}`}
              options={MONTHS.map((month, index) => ({
                value: `${index}`,
                label: month,
              }))}
              onChange={(next) =>
                setCursor((current) =>
                  utcDate(current.getUTCFullYear(), Number(next), 1),
                )
              }
            />

            <Select
              label="Year"
              className="datepicker__select datepicker__select--year"
              value={`${cursor.getUTCFullYear()}`}
              options={years}
              onChange={(next) =>
                setCursor((current) =>
                  utcDate(Number(next), current.getUTCMonth(), 1),
                )
              }
            />

            <button
              type="button"
              className="datepicker__nav"
              aria-label="Next month"
              onClick={() => moveMonths(1)}
            >
              <ChevronRightIcon size={16} />
            </button>
          </div>

          <div className="datepicker__weekdays" aria-hidden="true">
            {WEEKDAYS.map((day) => (
              <span key={day}>{day}</span>
            ))}
          </div>

          <div
            ref={grid}
            id={gridId}
            className="datepicker__grid"
            role="grid"
            aria-label={label}
            tabIndex={0}
            onKeyDown={onGridKeyDown}
          >
            {days.map((day) => {
              const outside = day.getUTCMonth() !== cursor.getUTCMonth()
              const allowed = clamp(day, minDate, maxDate)

              return (
                <button
                  key={day.toISOString()}
                  type="button"
                  role="gridcell"
                  className="datepicker__day"
                  data-outside={outside || undefined}
                  data-today={sameDay(day, now) || undefined}
                  data-cursor={sameDay(day, cursor) || undefined}
                  aria-selected={selected ? sameDay(day, selected) : false}
                  aria-label={format(day)}
                  disabled={!allowed}
                  // Tabbing must not walk 42 cells; the grid owns the focus.
                  tabIndex={-1}
                  onClick={() => commit(day)}
                >
                  {day.getUTCDate()}
                </button>
              )
            })}
          </div>

          <div className="datepicker__foot">
            <button
              type="button"
              className="btn-quiet"
              onClick={() => {
                onChange('')
                setOpen(false)
              }}
            >
              Clear
            </button>
            <button
              type="button"
              className="btn-quiet"
              disabled={!clamp(now, minDate, maxDate)}
              onClick={() => commit(now)}
            >
              Today
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

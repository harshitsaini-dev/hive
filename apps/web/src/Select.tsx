import { useEffect, useId, useRef, useState } from 'react'
import { ChevronDownIcon } from './Icons.js'

/**
 * A dropdown that matches the rest of the app.
 *
 * A native `<select>` cannot be styled where it matters: the closed control
 * takes CSS, but the open option list is drawn by the operating system, so a
 * dark app pops a white system menu. That is the only reason this exists —
 * the native element is otherwise better than anything hand-rolled.
 *
 * Which means the bar is high: everything the native control gives away for
 * free has to be rebuilt here. Arrow keys move the highlight, Home and End
 * jump, Enter and Space commit, Escape closes without changing anything, and
 * the roles are the ones a screen reader expects from a listbox.
 */

export interface SelectOption<T extends string> {
  value: T
  label: string
}

export function Select<T extends string>({
  id,
  label,
  value,
  options,
  onChange,
  className,
}: {
  id?: string
  /** Accessible name. Rendered visually only if `showLabel` callers add one. */
  label: string
  value: T
  options: readonly SelectOption<T>[]
  onChange: (value: T) => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const listId = useId()
  const buttonId = id ?? useId()

  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  )
  const selected = options[selectedIndex]

  // Opening should start from what is currently chosen, not from the top.
  useEffect(() => {
    if (open) setActive(selectedIndex)
  }, [open, selectedIndex])

  // Clicking anywhere else closes it, the way a real menu behaves.
  useEffect(() => {
    if (!open) return

    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }

    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  function commit(index: number) {
    const option = options[index]
    if (option) onChange(option.value)
    setOpen(false)
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (!open) {
      // The native control opens on these too, so this one has to as well.
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
        event.preventDefault()
        setOpen(true)
      }
      return
    }

    switch (event.key) {
      case 'Escape':
        event.preventDefault()
        setOpen(false)
        break
      case 'ArrowDown':
        event.preventDefault()
        setActive((index) => Math.min(index + 1, options.length - 1))
        break
      case 'ArrowUp':
        event.preventDefault()
        setActive((index) => Math.max(index - 1, 0))
        break
      case 'Home':
        event.preventDefault()
        setActive(0)
        break
      case 'End':
        event.preventDefault()
        setActive(options.length - 1)
        break
      case 'Enter':
      case ' ':
        event.preventDefault()
        commit(active)
        break
      default:
        break
    }
  }

  return (
    <div ref={root} className={className ? `select ${className}` : 'select'}>
      <button
        type="button"
        id={buttonId}
        className="select__button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={label}
        onClick={() => setOpen(!open)}
        onKeyDown={onKeyDown}
      >
        <span className="select__value">{selected?.label ?? ''}</span>
        <ChevronDownIcon size={15} />
      </button>

      {open && (
        <ul
          id={listId}
          className="select__list"
          role="listbox"
          aria-label={label}
          aria-activedescendant={`${listId}-${active}`}
          tabIndex={-1}
        >
          {options.map((option, index) => (
            <li
              key={option.value}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={option.value === value}
              data-active={index === active}
              className="select__option"
              // Pointer, not mouse: this is what makes it work on touch.
              onPointerEnter={() => setActive(index)}
              onClick={() => commit(index)}
            >
              {option.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

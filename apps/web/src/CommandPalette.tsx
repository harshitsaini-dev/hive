import { useEffect, useRef, useState } from 'react'
import { api, ApiRequestError, type MessageRow } from './api.js'
import { MailIcon, SearchIcon, TrashIcon } from './Icons.js'
import { Skeleton } from './Skeleton.js'

/**
 * Ctrl+K search across every connected mailbox.
 *
 * Deliberately does not duplicate the filter panel. This is for "where is that
 * one message" — type words, see results from all accounts interleaved by
 * date, jump to it. Narrowing by sender, age or category is what the panel in
 * the mail view is for, and the palette can hand off to it.
 */

const DEBOUNCE_MS = 350
const RESULT_LIMIT = 25

function senderName(from: string): string {
  const match = /^\s*"?([^"<]+?)"?\s*</.exec(from)
  return match?.[1]?.trim() || from.replace(/[<>]/g, '')
}

export function CommandPalette({
  open,
  onClose,
  onSeeAll,
}: {
  open: boolean
  onClose: () => void
  /** Hands the typed text to the mail view so it can be refined further. */
  onSeeAll: (text: string) => void
}) {
  const [text, setText] = useState('')
  const [results, setResults] = useState<MessageRow[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const dialog = useRef<HTMLDivElement>(null)

  // Reset on each open: a palette that remembers last week's search is a
  // palette you have to clear before you can use it.
  useEffect(() => {
    if (!open) return
    setText('')
    setResults(null)
    setError(null)
    input.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()

      if (event.key !== 'Tab' || !dialog.current) return

      // Focus stays inside while it is open, or Tab walks onto the page behind.
      const focusable = dialog.current.querySelectorAll<HTMLElement>(
        'input, button:not([disabled]), a[href]',
      )
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!first || !last) return

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  /*
   * Debounced, and every search races against the next keystroke. Without the
   * cancellation check a slow early request can land after a fast later one
   * and overwrite good results with stale ones.
   */
  useEffect(() => {
    if (!open) return

    const trimmed = text.trim()
    if (trimmed.length < 2) {
      setResults(null)
      setSearching(false)
      return
    }

    let cancelled = false
    setSearching(true)

    const timer = setTimeout(() => {
      api
        .searchMessages({ q: trimmed, pageSize: RESULT_LIMIT })
        .then((result) => {
          if (cancelled) return
          setResults(result.messages)
          setError(null)
        })
        .catch((caught: unknown) => {
          if (cancelled) return
          setError(
            caught instanceof ApiRequestError ? caught.message : 'Search failed.',
          )
        })
        .finally(() => {
          if (!cancelled) setSearching(false)
        })
    }, DEBOUNCE_MS)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [text, open])

  if (!open) return null

  return (
    <div
      className="modal-backdrop palette-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={dialog}
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Search all mailboxes"
      >
        <div className="palette__field">
          <SearchIcon size={18} />
          <label htmlFor="palette-input" className="sr-only">
            Search all mailboxes
          </label>
          <input
            id="palette-input"
            ref={input}
            type="search"
            value={text}
            placeholder="Search every connected account…"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && text.trim().length >= 2) {
                onSeeAll(text.trim())
                onClose()
              }
            }}
          />
          <kbd>Esc</kbd>
        </div>

        <div className="palette__body" role="status" aria-live="polite">
          {text.trim().length < 2 && (
            <p className="hint palette__empty">
              Type at least two characters. Results come from every connected
              mailbox at once.
            </p>
          )}

          {text.trim().length >= 2 && searching && (
            <div className="palette__loading" aria-hidden="true">
              {[0, 1, 2, 3].map((row) => (
                <div key={row} className="palette__row">
                  <Skeleton width={`${40 + row * 8}%`} height="0.85rem" />
                  <Skeleton width={`${55 + row * 5}%`} height="0.75rem" />
                </div>
              ))}
            </div>
          )}

          {error && <p className="bad palette__empty">{error}</p>}

          {!searching && results?.length === 0 && (
            <p className="hint palette__empty">Nothing matched.</p>
          )}

          {!searching && results && results.length > 0 && (
            <ul className="palette__results">
              {results.map((message) => (
                <li key={`${message.accountId}:${message.gmailMessageId}`}>
                  <span className="palette__icon">
                    {message.labels.includes('TRASH') ? (
                      <TrashIcon size={15} />
                    ) : (
                      <MailIcon size={15} />
                    )}
                  </span>
                  <span className="palette__text">
                    <span className="palette__subject">
                      {message.subject || '(no subject)'}
                    </span>
                    <span className="palette__meta">
                      {senderName(message.from)} · {message.gmailAddress}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="palette__foot">
          {/*
            The palette searches every mailbox with no folder scope, so these
            are the top few of however many matched — say so, or 25 rows read
            as "that is all there is".
          */}
          <span className="hint">
            {results && results.length >= RESULT_LIMIT
              ? `Top ${RESULT_LIMIT} of everything that matched — `
              : ''}
            <kbd>Enter</kbd> to see them all
          </span>
          <button
            type="button"
            className="link"
            disabled={text.trim().length < 2}
            onClick={() => {
              onSeeAll(text.trim())
              onClose()
            }}
          >
            See all results
          </button>
        </div>
      </div>
    </div>
  )
}

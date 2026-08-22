import { useEffect, useRef, useState } from 'react'
import { AlertIcon } from './Icons.js'

const PHRASE = 'permanently delete'

/**
 * The gate in front of irreversible deletion.
 *
 * Type-to-confirm rather than an OK button, deliberately. Confirmation dialogs
 * get dismissed reflexively; typing the phrase cannot happen by accident, and
 * reading it forces the count to register. ADR 0002 requires this — there is
 * no undo behind it.
 */
export function ConfirmDestructive({
  count,
  busy,
  onCancel,
  onConfirm,
}: {
  count: number
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const [typed, setTyped] = useState('')
  const dialog = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)

  const matches = typed.trim().toLowerCase() === PHRASE

  useEffect(() => {
    input.current?.focus()

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel()

      // Focus stays inside while the dialog is open, or Tab walks off into the
      // page behind it — which is both confusing and lets a keyboard user
      // trigger something else while a destructive prompt is up.
      if (event.key !== 'Tab' || !dialog.current) return

      const focusable = dialog.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input',
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
  }, [onCancel])

  return (
    <div
      className="modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <div
        ref={dialog}
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-body"
      >
        <span className="status-screen__icon status-screen__icon--bad">
          <AlertIcon size={24} />
        </span>

        <h2 id="confirm-title">
          Permanently delete {count} message{count === 1 ? '' : 's'}?
        </h2>

        <p id="confirm-body" className="hint">
          This cannot be undone. These messages will not go to Trash — they are
          removed from Gmail entirely, and no one can recover them.
        </p>

        <label htmlFor="confirm-phrase">
          Type <code>{PHRASE}</code> to confirm
        </label>
        <input
          id="confirm-phrase"
          ref={input}
          value={typed}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && matches && !busy) onConfirm()
          }}
        />

        <div className="modal__actions">
          <button type="button" className="link" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-danger"
            disabled={!matches || busy}
            onClick={onConfirm}
          >
            {busy ? 'Deleting…' : 'Delete forever'}
          </button>
        </div>
      </div>
    </div>
  )
}

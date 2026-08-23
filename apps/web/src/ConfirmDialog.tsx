import { useEffect, useRef } from 'react'
import { AlertIcon } from './Icons.js'

/**
 * The app's own confirmation, for reversible actions.
 *
 * `window.confirm` was doing this job and looked exactly like what it is: a
 * browser chrome box, titled with the domain name, in the operating system's
 * colours, in the middle of a themed app. It also blocks the page thread, so
 * nothing behind it can even repaint while it is up.
 *
 * Not a replacement for {@link ConfirmDestructive}, which guards permanent
 * deletion and requires a typed phrase. This is the lighter gate in front of
 * actions that can be undone — an OK button is proportionate when the answer
 * to a misclick is "restore it from Trash".
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  busy = false,
  onCancel,
  onConfirm,
}: {
  title: string
  body: string
  confirmLabel: string
  busy?: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const dialog = useRef<HTMLDivElement>(null)
  const confirm = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    confirm.current?.focus()

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel()

      // Focus stays inside while it is open, or Tab walks off into the page
      // behind and a keyboard user can trigger something else mid-prompt.
      if (event.key !== 'Tab' || !dialog.current) return

      const focusable = dialog.current.querySelectorAll<HTMLElement>(
        'button:not([disabled])',
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
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-body"
      >
        <span className="status-screen__icon status-screen__icon--warn">
          <AlertIcon size={24} />
        </span>

        <h2 id="confirm-dialog-title">{title}</h2>
        <p id="confirm-dialog-body" className="hint">
          {body}
        </p>

        <div className="modal__actions">
          <button
            type="button"
            className="link"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            ref={confirm}
            type="button"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

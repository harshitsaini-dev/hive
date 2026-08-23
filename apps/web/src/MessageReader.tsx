import { useEffect, useState } from 'react'
import { api, ApiRequestError, type ParsedMessage } from './api.js'
import { AlertIcon, MailIcon } from './Icons.js'
import { Skeleton } from './Skeleton.js'

/**
 * The reading pane.
 *
 * Message bodies are fetched live every time and never stored — that is the
 * privacy claim, and the only way it stays true is by having nowhere to put
 * them.
 */

function formatFullDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function MessageReader({
  accountId,
  messageId,
  onClose,
}: {
  accountId: string
  messageId: string
  onClose: () => void
}) {
  const [message, setMessage] = useState<ParsedMessage | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setMessage(null)
    setError(null)

    api
      .getMessage(accountId, messageId)
      .then((result) => {
        if (!cancelled) setMessage(result.message)
      })
      .catch((caught: unknown) => {
        if (cancelled) return
        setError(
          caught instanceof ApiRequestError
            ? caught.message
            : 'Could not open that message.',
        )
      })

    return () => {
      cancelled = true
    }
  }, [accountId, messageId])

  return (
    <aside className="reader" aria-label="Message">
      <div className="reader__bar">
        <button type="button" className="link" onClick={onClose}>
          Close
        </button>
      </div>

      {!message && !error && (
        <div className="reader__body" aria-hidden="true">
          <Skeleton width="70%" height="1.3rem" />
          <Skeleton width="45%" height="0.9rem" />
          <div style={{ height: '1rem' }} />
          <Skeleton height="0.85rem" />
          <Skeleton width="92%" height="0.85rem" />
          <Skeleton width="84%" height="0.85rem" />
          <Skeleton width="60%" height="0.85rem" />
        </div>
      )}

      {error && (
        <div className="reader__body">
          <p className="bad">
            <AlertIcon size={15} /> {error}
          </p>
        </div>
      )}

      {message && (
        <div className="reader__body">
          <h2 className="reader__subject">
            {message.subject || '(no subject)'}
          </h2>

          <dl className="reader__meta">
            <div>
              <dt>From</dt>
              <dd>{message.from || 'unknown'}</dd>
            </div>
            {message.to && (
              <div>
                <dt>To</dt>
                <dd>{message.to}</dd>
              </div>
            )}
            {message.cc && (
              <div>
                <dt>Cc</dt>
                <dd>{message.cc}</dd>
              </div>
            )}
            <div>
              <dt>Date</dt>
              <dd>{formatFullDate(message.date)}</dd>
            </div>
          </dl>

          {message.attachments.length > 0 && (
            <ul className="reader__attachments">
              {message.attachments.map((attachment) => (
                <li key={attachment.attachmentId}>
                  <a
                    href={api.attachmentUrl(
                      accountId,
                      message.id,
                      attachment.attachmentId,
                      attachment.filename,
                    )}
                    download={attachment.filename}
                  >
                    {attachment.filename}
                  </a>
                  <span className="hint">{formatBytes(attachment.size)}</span>
                </li>
              ))}
            </ul>
          )}

          <MessageBody message={message} />
        </div>
      )}
    </aside>
  )
}

function MessageBody({ message }: { message: ParsedMessage }) {
  const [showHtml, setShowHtml] = useState(false)

  if (message.text) {
    return (
      <>
        <pre className="reader__text">{message.text}</pre>

        {/*
          HTML is offered, never rendered by default.
          The markup comes from whoever sent the message and could carry
          tracking pixels, remote images that leak the read, or script. A
          sandboxed iframe with no allow-scripts and no same-origin means it
          cannot reach this page, this origin's cookies, or the session.
        */}
        {message.html && (
          <div className="reader__htmltoggle">
            <button
              type="button"
              className="link"
              onClick={() => setShowHtml(!showHtml)}
            >
              {showHtml ? 'Hide formatted version' : 'Show formatted version'}
            </button>
            {showHtml && <HtmlFrame html={message.html} />}
          </div>
        )}
      </>
    )
  }

  if (message.html) {
    return (
      <>
        <p className="hint reader__note">
          <MailIcon size={14} />
          This message has no plain-text version. Shown in an isolated frame
          with remote content and scripts blocked.
        </p>
        <HtmlFrame html={message.html} />
      </>
    )
  }

  return <p className="hint">{message.snippet || 'This message is empty.'}</p>
}

/**
 * Renders sender HTML inside a locked-down iframe.
 *
 * `sandbox` with no tokens is the maximum restriction the attribute allows:
 * no script, no forms, no navigation, and a null origin so it shares nothing
 * with this page. The CSP meta blocks remote loads, which is what stops a
 * tracking pixel from reporting that the mail was opened.
 */
function HtmlFrame({ html }: { html: string }) {
  const document = `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; img-src data:;">
<style>
  body { margin:0; padding:12px; font:14px/1.5 system-ui, sans-serif; color:#2b2620; background:#fff; }
  img { max-width:100%; height:auto; }
  a { pointer-events:none; color:inherit; }
</style>
</head><body>${html}</body></html>`

  return (
    <iframe
      className="reader__frame"
      title="Message content"
      sandbox=""
      srcDoc={document}
    />
  )
}

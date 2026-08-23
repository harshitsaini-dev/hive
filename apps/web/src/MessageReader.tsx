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

/*
 * Raster formats only, matching what the server will agree to serve inline.
 * SVG is an image and is deliberately absent: it is a document that can carry
 * script, so it stays a download however it is labelled.
 */
function isImage(mimeType: string): boolean {
  return /^image\/(jpeg|jpg|png|gif|webp)$/i.test(mimeType)
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
        <button type="button" className="btn-quiet" onClick={onClose}>
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
              {message.attachments.map((attachment) => {
                const image = isImage(attachment.mimeType)

                return (
                  <li
                    key={attachment.attachmentId}
                    data-image={image || undefined}
                  >
                    {/*
                      A photo shown as a filename is a photo you have to
                      download to find out what it is. The thumbnail is the
                      attachment itself, served inline — the server checks the
                      bytes really are a raster image before it agrees to
                      render anything in this origin.
                    */}
                    {image && (
                      <img
                        className="reader__thumb"
                        src={api.attachmentUrl(
                          accountId,
                          message.id,
                          attachment.attachmentId,
                          attachment.filename,
                          true,
                        )}
                        alt={attachment.filename}
                        loading="lazy"
                      />
                    )}

                    <span className="reader__file">
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
                      <span className="hint">
                        {formatBytes(attachment.size)}
                      </span>
                    </span>
                  </li>
                )
              })}
            </ul>
          )}

          <MessageBody
            message={message}
            inlineSrc={(contentId) => {
              const match = message.attachments.find(
                (attachment) => attachment.contentId === contentId,
              )
              return match
                ? api.attachmentUrl(
                    accountId,
                    message.id,
                    match.attachmentId,
                    match.filename,
                    true,
                  )
                : null
            }}
          />
        </div>
      )}
    </aside>
  )
}

function MessageBody({
  message,
  inlineSrc,
}: {
  message: ParsedMessage
  /** Resolves a `cid:` reference to a URL, or null if nothing matches it. */
  inlineSrc: (contentId: string) => string | null
}) {
  const [showHtml, setShowHtml] = useState(false)

  if (message.text) {
    return (
      <>
        <pre className="reader__text">{message.text}</pre>

        {/*
          HTML is offered, never rendered by default. The markup comes from
          whoever sent the message and could carry tracking pixels, remote
          images that leak the read, or script — see HtmlFrame for how each of
          those is blocked.
        */}
        {message.html && (
          <div className="reader__htmltoggle">
            <button
              type="button"
              className="btn-quiet"
              onClick={() => setShowHtml(!showHtml)}
            >
              {showHtml ? 'Hide formatted version' : 'Show formatted version'}
            </button>
            {showHtml && (
              <HtmlFrame html={message.html} inlineSrc={inlineSrc} />
            )}
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
        <HtmlFrame html={message.html} inlineSrc={inlineSrc} />
      </>
    )
  }

  return <p className="hint">{message.snippet || 'This message is empty.'}</p>
}

/**
 * Renders sender HTML inside a locked-down iframe that sizes to its content.
 *
 * **On the sandbox value.** `sandbox=""` is the strictest setting, but it
 * gives the frame a null origin, so the parent cannot measure it — which left
 * a short fixed-height box with its own scrollbar nested inside the reader's,
 * and a long email became a letterbox.
 *
 * `allow-same-origin` *without* `allow-scripts` is the tradeoff taken here.
 * Scripting stays off, and with no script able to run there is nothing to
 * exploit the shared origin with: no access to cookies, storage or the parent
 * DOM. The CSP below still blocks every remote load, so a tracking pixel
 * cannot report that the message was opened.
 *
 * Adding `allow-scripts` alongside `allow-same-origin` would undo all of this
 * at once — the combination lets the frame remove its own sandbox. Never do
 * both.
 */
/**
 * A remote `<img src="http...">`, captured so it can be set aside.
 *
 * Anchored on the tag rather than the attribute alone: a `src` on some other
 * element is not an image and must not be touched.
 */
const REMOTE_IMG = /(<img\b[^>]*?)\ssrc\s*=\s*(["'])(https?:[^"']*)\2/gi

function HtmlFrame({
  html,
  inlineSrc,
}: {
  html: string
  inlineSrc: (contentId: string) => string | null
}) {
  // Small enough that a one-line message does not sit in a tall empty box;
  // measurement replaces it as soon as the frame loads.
  const [height, setHeight] = useState(120)
  /*
   * Remote images stay blocked until asked for, one message at a time.
   *
   * Not a setting, and not remembered: consenting to load a sender's images
   * is consenting to tell them the message was opened, and that is a decision
   * about this message rather than a preference about all of them.
   */
  const [showRemote, setShowRemote] = useState(false)

  /*
   * `cid:` is how a sender embeds a picture in the body: the markup points at
   * a Content-ID and the bytes travel as an attachment on the same message.
   * The frame has no idea what a `cid:` URL means, so every embedded image
   * rendered as a broken-image icon. Rewritten here to the attachment
   * endpoint, which is same-origin and therefore allowed by the CSP below.
   *
   * Remote `http(s)` images are still blocked and deliberately not rewritten:
   * loading one tells the sender the message was opened, and that is the
   * tracking pixel this app refuses to fire.
   */
  const embedded = html.replace(
    /(\ssrc\s*=\s*)(["'])cid:([^"']+)\2/gi,
    (whole, prefix: string, quote: string, contentId: string) => {
      const url = inlineSrc(decodeURIComponent(contentId).trim())
      return url ? `${prefix}${quote}${url}${quote}` : whole
    },
  )

  /*
   * Blocking a remote image is not the same as leaving a broken one.
   *
   * The CSP already stopped these loading, which is the point — but the
   * markup still said "there is a picture here", so a newsletter opened as a
   * field of grey broken-image icons and looked like Hive had failed to
   * render it. The `src` is moved aside instead, so the browser never has an
   * image to fail at, and the count drives an offer to load them properly.
   */
  let blocked = 0
  const resolved = showRemote
    ? embedded
    : embedded.replace(
        REMOTE_IMG,
        (_whole: string, before: string, quote: string, url: string) => {
          blocked += 1
          return `${before} data-blocked=${quote}${url}${quote}`
        },
      )

  const document = `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; img-src data: 'self'${showRemote ? ' https:' : ''};">
<style>
  html, body { margin:0; padding:0; }
  body { padding:14px; font:14px/1.6 system-ui, -apple-system, 'Segoe UI', sans-serif;
         color:#2b2620; background:#fff; overflow-x:hidden; word-break:break-word; }
  img { max-width:100%; height:auto; }
  /* Nothing to render and nothing to fail at, so no broken-image icon. */
  img[data-blocked] { display:none; }
  table { max-width:100% !important; }
  a { pointer-events:none; color:inherit; }
</style>
</head><body>${resolved}</body></html>`

  function measure(frame: HTMLIFrameElement | null) {
    const body = frame?.contentDocument?.body
    if (!body) return

    /*
     * The body, not documentElement.
     *
     * `documentElement.scrollHeight` reports the frame's own height whenever
     * the content is shorter than it — measured 150 for a one-line message,
     * which is how a two-word email ended up in a tall empty box. The body
     * reports the content itself, and still grows past the frame when the
     * message is long.
     */
    const measured = Math.max(body.scrollHeight, body.offsetHeight)
    if (measured > 0) setHeight(measured + 2)
  }

  return (
    <>
      {blocked > 0 && (
        <div className="reader__blocked">
          <span className="hint">
            {blocked} image{blocked === 1 ? '' : 's'} not loaded. Fetching them
            tells the sender you opened this.
          </span>
          <button
            type="button"
            className="btn-quiet"
            onClick={() => setShowRemote(true)}
          >
            Show images
          </button>
        </div>
      )}

    <iframe
      className="reader__frame"
      title="Message content"
      sandbox="allow-same-origin"
      srcDoc={document}
      style={{ height: `${height}px` }}
      // Remote content is blocked by the CSP, so nothing loads late and
      // changes the height after this fires.
      onLoad={(event) => measure(event.currentTarget)}
    />
    </>
  )
}

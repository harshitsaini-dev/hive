import { useState, type FormEvent } from 'react'
import type { ConnectedAccount } from '@hive/shared-types'
import { api, ApiRequestError } from './api.js'
import { SendIcon } from './Icons.js'

/**
 * Gmail refuses anything over 25 MB, and base64 inflates bytes by about a
 * third — so 18 MB of actual files is the real ceiling. Checked here so the
 * refusal is instant rather than after a long upload.
 */
const MAX_TOTAL_BYTES = 18 * 1024 * 1024

interface PickedFile {
  filename: string
  mimeType: string
  base64: string
  bytes: number
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Reads a file to base64 without the `data:...;base64,` prefix. */
function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`))
    reader.onload = () => {
      const result = String(reader.result)
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.readAsDataURL(file)
  })
}

export function ComposePanel({ accounts }: { accounts: ConnectedAccount[] }) {
  const [open, setOpen] = useState(false)
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '')
  const [to, setTo] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [files, setFiles] = useState<PickedFile[]>([])

  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0)

  async function addFiles(list: FileList | null) {
    if (!list || list.length === 0) return
    setError(null)

    try {
      const picked = await Promise.all(
        Array.from(list).map(async (file) => ({
          filename: file.name,
          mimeType: file.type || 'application/octet-stream',
          base64: await readAsBase64(file),
          bytes: file.size,
        })),
      )

      const combined = [...files, ...picked]
      const size = combined.reduce((sum, file) => sum + file.bytes, 0)

      // Checked against the combined total, not each file: three 8 MB files
      // are individually fine and together over the limit.
      if (size > MAX_TOTAL_BYTES) {
        setError(
          `That would be ${formatBytes(size)} of attachments. Gmail allows about ${formatBytes(MAX_TOTAL_BYTES)}.`,
        )
        return
      }

      setFiles(combined)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not read that file.')
    }
  }

  async function send(event: FormEvent) {
    event.preventDefault()
    setSending(true)
    setError(null)
    setNotice(null)

    try {
      await api.sendMessage({
        accountId,
        to: to.trim(),
        subject,
        body,
        attachments: files.map(({ filename, mimeType, base64 }) => ({
          filename,
          mimeType,
          base64,
        })),
      })

      setNotice(`Sent to ${to.trim()}.`)
      setTo('')
      setSubject('')
      setBody('')
      setFiles([])
      setOpen(false)
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError ? caught.message : 'Could not send that.',
      )
    } finally {
      setSending(false)
    }
  }

  const from =
    accounts.find((account) => account.id === accountId)?.gmailAddress ?? ''

  return (
    <section className="card compose">
      <div className="card__head">
        <h2>
          <SendIcon size={17} />
          Compose
        </h2>
        <button
          type="button"
          className={open ? 'link' : 'icon-btn'}
          onClick={() => setOpen(!open)}
        >
          {open ? 'Close' : 'New message'}
        </button>
      </div>

      <div role="status" aria-live="polite">
        {notice && <p className="notice">{notice}</p>}
      </div>

      {open && (
        <form className="compose__form" onSubmit={send}>
          <label htmlFor="compose-from">From</label>
          <select
            id="compose-from"
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
          >
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.gmailAddress}
              </option>
            ))}
          </select>

          <label htmlFor="compose-to">To</label>
          <input
            id="compose-to"
            type="email"
            required
            value={to}
            placeholder="someone@example.com"
            onChange={(event) => setTo(event.target.value)}
          />

          <label htmlFor="compose-subject">Subject</label>
          <input
            id="compose-subject"
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
          />

          <label htmlFor="compose-body">Message</label>
          <textarea
            id="compose-body"
            rows={7}
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />

          <label htmlFor="compose-files">Attachments</label>
          <input
            id="compose-files"
            type="file"
            multiple
            onChange={(event) => void addFiles(event.target.files)}
          />

          {files.length > 0 && (
            <ul className="attachlist">
              {files.map((file, index) => (
                <li key={`${file.filename}:${index}`}>
                  <span>{file.filename}</span>
                  <span className="hint">{formatBytes(file.bytes)}</span>
                  <button
                    type="button"
                    className="link"
                    onClick={() =>
                      setFiles(files.filter((_, at) => at !== index))
                    }
                  >
                    Remove
                  </button>
                </li>
              ))}
              <li className="attachlist__total">
                <span className="hint">
                  {formatBytes(totalBytes)} of {formatBytes(MAX_TOTAL_BYTES)} used
                </span>
              </li>
            </ul>
          )}

          {/*
            Gmail's own daily cap, stated rather than tracked. Hive does not
            count sends — a local counter would drift from Google's and either
            block valid sends or promise capacity that is not there.
          */}
          <p className="hint">
            Sending as <strong>{from}</strong>. Gmail allows around 500 messages
            a day on a personal account, 2,000 on Workspace; it will refuse
            beyond that and Hive will say so.
          </p>

          <button
            type="submit"
            className="icon-btn"
            disabled={sending || to.trim() === ''}
          >
            <SendIcon size={16} />
            {sending ? 'Sending…' : 'Send'}
          </button>
        </form>
      )}

      <div role="alert" aria-live="assertive">
        {error && <p className="bad">{error}</p>}
      </div>
    </section>
  )
}

import { useState, type FormEvent } from 'react'
import type { ConnectedAccount } from '@hive/shared-types'
import { api, ApiRequestError } from './api.js'
import { SendIcon } from './Icons.js'

export function ComposePanel({ accounts }: { accounts: ConnectedAccount[] }) {
  const [open, setOpen] = useState(false)
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '')
  const [to, setTo] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function send(event: FormEvent) {
    event.preventDefault()
    setSending(true)
    setError(null)
    setNotice(null)

    try {
      await api.sendMessage({ accountId, to: to.trim(), subject, body })

      setNotice(`Sent to ${to.trim()}.`)
      setTo('')
      setSubject('')
      setBody('')
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

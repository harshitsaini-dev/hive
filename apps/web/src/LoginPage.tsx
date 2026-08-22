import { useState, type FormEvent } from 'react'
import { api, ApiRequestError, type User } from './api.js'

type Stage = 'email' | 'code'

/**
 * Passwordless login. Two steps, one form — the second stage keeps the email
 * visible and offers a way back, because mistyping the address is the most
 * likely reason a code never arrives.
 */
export function LoginPage({ onSignedIn }: { onSignedIn: (user: User) => void }) {
  const [stage, setStage] = useState<Stage>('email')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const fail = (caught: unknown) => {
    setError(
      caught instanceof ApiRequestError
        ? caught.message
        : 'Could not reach the server.',
    )
  }

  async function submitEmail(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)

    try {
      const { expiresInMinutes } = await api.requestCode(email)
      setStage('code')
      setNotice(`We sent a six-digit code to ${email}. It expires in ${expiresInMinutes} minutes.`)
    } catch (caught) {
      fail(caught)
    } finally {
      setBusy(false)
    }
  }

  async function submitCode(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)

    try {
      const { user } = await api.verifyCode(email, code)
      onSignedIn(user)
    } catch (caught) {
      fail(caught)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="shell shell--narrow">
      <h1>Hive</h1>
      <p className="tagline">Manage several Gmail accounts from one place.</p>

      {stage === 'email' ? (
        <form onSubmit={submitEmail} className="card" noValidate>
          <h2>Sign in</h2>

          <label htmlFor="email">Email address</label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
          />

          <button type="submit" disabled={busy || email.trim() === ''}>
            {busy ? 'Sending…' : 'Send me a code'}
          </button>

          <p className="hint">
            No password. We email you a code each time you sign in.
          </p>
        </form>
      ) : (
        <form onSubmit={submitCode} className="card" noValidate>
          <h2>Enter your code</h2>

          {notice && <p className="hint">{notice}</p>}

          <label htmlFor="code">Six-digit code</label>
          <input
            id="code"
            name="code"
            // inputMode rather than type=number: number inputs allow signs and
            // exponents, and spinners on a one-time code are nonsense.
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            required
            autoFocus
            value={code}
            onChange={(event) =>
              setCode(event.target.value.replace(/\D/g, '').slice(0, 6))
            }
            placeholder="000000"
          />

          <button type="submit" disabled={busy || code.length !== 6}>
            {busy ? 'Checking…' : 'Sign in'}
          </button>

          <button
            type="button"
            className="link"
            onClick={() => {
              setStage('email')
              setCode('')
              setError(null)
              setNotice(null)
            }}
          >
            Use a different email
          </button>
        </form>
      )}

      <div role="alert" aria-live="assertive">
        {error && <p className="bad">{error}</p>}
      </div>
    </main>
  )
}

import { useEffect, useRef, useState } from 'react'
import { api, ApiRequestError } from '../api.js'
import { AlertIcon, CheckIcon, HiveMark } from '../Icons.js'
import { Skeleton } from '../Skeleton.js'

type Outcome =
  | { state: 'working' }
  | { state: 'done'; address: string }
  | { state: 'cancelled' }
  | { state: 'failed'; message: string }

/**
 * The page Google redirects back to.
 *
 * Google sends the browser here — to the *web app*, not the API — and this
 * page then completes the connection with a same-origin request. The earlier
 * design pointed Google straight at an API route, which failed in production
 * with a bare 401: a cross-site top-level navigation does not reliably carry a
 * `SameSite=Lax` session cookie. A fetch from a page already loaded on this
 * origin always does.
 */
export function OAuthCallbackView({ onFinished }: { onFinished: () => void }) {
  const [outcome, setOutcome] = useState<Outcome>({ state: 'working' })

  /*
   * React runs effects twice in StrictMode, and an authorization code is
   * single-use — the second exchange would fail and overwrite a perfectly
   * good result with an error.
   */
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true

    const params = new URLSearchParams(window.location.search)

    // Strip the code from the address bar immediately. It is single-use, but
    // it has no business sitting in history or being copied out of the URL.
    window.history.replaceState({}, '', '/accounts')

    if (params.get('error')) {
      setOutcome({ state: 'cancelled' })
      return
    }

    const code = params.get('code')
    const state = params.get('state')

    if (!code || !state) {
      setOutcome({ state: 'failed', message: 'That link was incomplete.' })
      return
    }

    api
      .completeConnect(code, state)
      .then(({ account }) =>
        setOutcome({ state: 'done', address: account.gmailAddress }),
      )
      .catch((error: unknown) =>
        setOutcome({
          state: 'failed',
          message:
            error instanceof ApiRequestError
              ? error.message
              : 'Could not finish connecting that account.',
        }),
      )
  }, [])

  // Straight through on success — there is nothing here worth reading.
  useEffect(() => {
    if (outcome.state === 'done' || outcome.state === 'cancelled') {
      const timer = setTimeout(onFinished, outcome.state === 'done' ? 900 : 400)
      return () => clearTimeout(timer)
    }
    return undefined
  }, [outcome, onFinished])

  return (
    <div className="landing">
      <header className="landing__bar">
        <span className="landing__mark">
          <HiveMark size={22} />
          Hive
        </span>
      </header>

      <main className="shell shell--narrow status-screen__main">
        <div className="status-screen__card" role="status" aria-live="polite">
          {outcome.state === 'working' && (
            <>
              <h1>Connecting your account…</h1>
              <p className="hint">Finishing up with Google.</p>
              <div style={{ marginTop: '1.25rem' }}>
                <Skeleton height="2.25rem" radius="0.75rem" />
              </div>
            </>
          )}

          {outcome.state === 'done' && (
            <>
              <span className="status-screen__icon status-screen__icon--neutral">
                <CheckIcon size={26} />
              </span>
              <h1>Connected</h1>
              <p className="hint">{outcome.address} is ready to use.</p>
            </>
          )}

          {outcome.state === 'cancelled' && (
            <>
              <h1>Connection cancelled</h1>
              <p className="hint">Nothing changed. Taking you back.</p>
            </>
          )}

          {outcome.state === 'failed' && (
            <>
              <span className="status-screen__icon status-screen__icon--bad">
                <AlertIcon size={26} />
              </span>
              <h1>That did not finish</h1>
              <p className="hint">{outcome.message}</p>
              <div className="status-screen__actions">
                <button type="button" onClick={onFinished}>
                  Back to accounts
                </button>
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  )
}

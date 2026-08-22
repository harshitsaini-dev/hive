import { useCallback, useEffect, useState } from 'react'
import { api, ApiRequestError, type User } from './api.js'
import { LandingPage } from './LandingPage.js'
import { LoginPage } from './LoginPage.js'
import { AccountsPage } from './AccountsPage.js'
import { StatusScreen } from './StatusScreen.js'
import { useOnline } from './useOnline.js'

type Auth =
  | { state: 'checking' }
  | { state: 'anonymous' }
  | { state: 'signed-in'; user: User }
  | { state: 'unreachable'; detail: string | null }

/** The only paths the app serves. Anything else is a 404. */
const KNOWN_PATHS = new Set(['/', '/accounts'])

export function App() {
  const [auth, setAuth] = useState<Auth>({ state: 'checking' })
  const online = useOnline()

  /**
   * Signed-out visitors see the landing page first. `?signin` sends them
   * straight to the form instead — which is also where the OAuth callback
   * bounces anyone whose session expired mid-connect.
   */
  const [wantsSignIn, setWantsSignIn] = useState(
    () => new URLSearchParams(window.location.search).has('signin'),
  )

  const check = useCallback(() => {
    setAuth({ state: 'checking' })

    api
      .me()
      .then(({ user }) => setAuth({ state: 'signed-in', user }))
      .catch((error: unknown) => {
        // A 401 is the expected answer for a signed-out visitor. Anything else
        // means the API is broken or unreachable, which is a different screen
        // and must not be silently rendered as "please sign in".
        if (error instanceof ApiRequestError && error.status === 401) {
          setAuth({ state: 'anonymous' })
          return
        }

        setAuth({
          state: 'unreachable',
          detail: error instanceof Error ? error.message : null,
        })
      })
  }, [])

  useEffect(check, [check])

  // Offline wins over everything: nothing else on screen would be truthful.
  if (!online) {
    return (
      <StatusScreen
        kind="offline"
        actions={[{ label: 'Try again', primary: true, onClick: check }]}
      />
    )
  }

  if (window.location.pathname !== '/' && !KNOWN_PATHS.has(window.location.pathname)) {
    return (
      <StatusScreen
        kind="not-found"
        detail={window.location.pathname}
        actions={[
          {
            label: 'Go to Hive',
            primary: true,
            onClick: () => {
              window.location.href = '/'
            },
          },
        ]}
      />
    )
  }

  if (auth.state === 'checking') {
    return (
      <main className="shell">
        <p className="hint" role="status">
          Loading…
        </p>
      </main>
    )
  }

  if (auth.state === 'unreachable') {
    return (
      <StatusScreen
        kind="server-error"
        detail={import.meta.env.DEV ? auth.detail : null}
        actions={[{ label: 'Try again', primary: true, onClick: check }]}
      />
    )
  }

  if (auth.state === 'anonymous') {
    return wantsSignIn ? (
      <LoginPage
        onSignedIn={(user) => setAuth({ state: 'signed-in', user })}
        onBack={() => setWantsSignIn(false)}
      />
    ) : (
      <LandingPage onGetStarted={() => setWantsSignIn(true)} />
    )
  }

  return (
    <AccountsPage
      user={auth.user}
      onSignedOut={() => {
        setWantsSignIn(false)
        setAuth({ state: 'anonymous' })
      }}
      onSessionLost={() => {
        setWantsSignIn(true)
        setAuth({ state: 'anonymous' })
      }}
    />
  )
}

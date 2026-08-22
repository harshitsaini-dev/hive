import { useEffect, useState } from 'react'
import { api, type User } from './api.js'
import { LandingPage } from './LandingPage.js'
import { LoginPage } from './LoginPage.js'
import { AccountsPage } from './AccountsPage.js'

type Auth =
  | { state: 'checking' }
  | { state: 'anonymous' }
  | { state: 'signed-in'; user: User }

export function App() {
  const [auth, setAuth] = useState<Auth>({ state: 'checking' })

  /**
   * Signed-out visitors see the landing page first. `?signin` sends them
   * straight to the form instead — which is also where the OAuth callback
   * bounces anyone whose session expired mid-connect.
   */
  const [wantsSignIn, setWantsSignIn] = useState(
    () => new URLSearchParams(window.location.search).has('signin'),
  )

  // One call on mount decides which page to show. Rendering the landing page
  // first and swapping it out would flash the wrong screen at every signed-in
  // user on every refresh.
  useEffect(() => {
    let cancelled = false

    api
      .me()
      .then(({ user }) => {
        if (!cancelled) setAuth({ state: 'signed-in', user })
      })
      .catch(() => {
        if (!cancelled) setAuth({ state: 'anonymous' })
      })

    return () => {
      cancelled = true
    }
  }, [])

  if (auth.state === 'checking') {
    return (
      <main className="shell">
        <p className="hint" role="status">
          Loading…
        </p>
      </main>
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
    />
  )
}

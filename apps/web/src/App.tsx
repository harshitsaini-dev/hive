import { useEffect, useState } from 'react'
import { api, type User } from './api.js'
import { LoginPage } from './LoginPage.js'
import { AccountsPage } from './AccountsPage.js'

type Auth =
  | { state: 'checking' }
  | { state: 'anonymous' }
  | { state: 'signed-in'; user: User }

export function App() {
  const [auth, setAuth] = useState<Auth>({ state: 'checking' })

  // One call on mount decides which page to show. Rendering the login form
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
    return (
      <LoginPage onSignedIn={(user) => setAuth({ state: 'signed-in', user })} />
    )
  }

  return (
    <AccountsPage
      user={auth.user}
      onSignedOut={() => setAuth({ state: 'anonymous' })}
    />
  )
}

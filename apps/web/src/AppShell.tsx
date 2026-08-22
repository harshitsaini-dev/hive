import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { ConnectedAccount } from '@hive/shared-types'
import { api, ApiRequestError, type User } from './api.js'
import { AccountsView } from './views/AccountsView.js'
import { ComposeView } from './views/ComposeView.js'
import { MailView } from './views/MailView.js'
import { RulesView } from './views/RulesView.js'
import {
  HiveMark,
  LogoutIcon,
  MailIcon,
  PlusIcon,
  ScheduleIcon,
  SendIcon,
  TrashIcon,
} from './Icons.js'
import { StatusScreen } from './StatusScreen.js'
import { ThemeToggle } from './ThemeToggle.js'

export type ViewId = 'inbox' | 'trash' | 'compose' | 'rules' | 'accounts'

const NAV = [
  { id: 'inbox', label: 'Inbox', Icon: MailIcon },
  { id: 'trash', label: 'Trash', Icon: TrashIcon },
  { id: 'compose', label: 'Compose', Icon: SendIcon },
  { id: 'rules', label: 'Rules', Icon: ScheduleIcon },
  { id: 'accounts', label: 'Accounts', Icon: PlusIcon },
] as const

interface AccountsState {
  loading: boolean
  accounts: ConnectedAccount[]
  error: string | null
  denied: boolean
}

export function AppShell({
  user,
  onSignedOut,
  onSessionLost,
}: {
  user: User
  onSignedOut: () => void
  onSessionLost: () => void
}) {
  const [view, setView] = useState<ViewId>('inbox')
  const [navOpen, setNavOpen] = useState(false)
  const [state, setState] = useState<AccountsState>({
    loading: true,
    accounts: [],
    error: null,
    denied: false,
  })

  const refresh = useCallback(async () => {
    setState((previous) => ({ ...previous, loading: true, error: null }))

    try {
      const { accounts } = await api.listAccounts()
      setState({ loading: false, accounts, error: null, denied: false })
    } catch (caught) {
      // The session ended underneath us — expired, or revoked elsewhere.
      if (
        caught instanceof ApiRequestError &&
        (caught.status === 401 || caught.status === 403)
      ) {
        setState({ loading: false, accounts: [], error: null, denied: true })
        return
      }

      setState({
        loading: false,
        accounts: [],
        denied: false,
        error:
          caught instanceof ApiRequestError
            ? caught.message
            : 'Could not load your accounts.',
      })
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Choosing a destination on mobile should close the drawer behind you.
  const go = (next: ViewId) => {
    setView(next)
    setNavOpen(false)
  }

  if (state.denied) {
    return (
      <StatusScreen
        kind="access-denied"
        actions={[{ label: 'Sign in again', primary: true, onClick: onSessionLost }]}
      />
    )
  }

  const hasAccounts = state.accounts.length > 0

  /**
   * Every view except Accounts needs a connected mailbox. Rather than each one
   * rendering its own empty state, they are gated here and pointed at the one
   * action that resolves it.
   */
  const needsAccount = !state.loading && !hasAccounts && view !== 'accounts'

  let body: ReactNode
  if (needsAccount) {
    body = (
      <div className="card">
        <h2>
          <MailIcon size={17} />
          Connect a mailbox first
        </h2>
        <p className="hint">
          There is nothing to show until Hive has a Gmail account to read.
        </p>
        <button
          type="button"
          className="icon-btn"
          onClick={() => go('accounts')}
          style={{ alignSelf: 'flex-start' }}
        >
          <PlusIcon size={16} />
          Go to Accounts
        </button>
      </div>
    )
  } else if (view === 'accounts') {
    body = (
      <AccountsView
        loading={state.loading}
        accounts={state.accounts}
        error={state.error}
        onChanged={refresh}
      />
    )
  } else if (view === 'compose') {
    body = <ComposeView accounts={state.accounts} loading={state.loading} />
  } else if (view === 'rules') {
    body = <RulesView accounts={state.accounts} loading={state.loading} />
  } else {
    body = (
      <MailView
        key={view}
        accounts={state.accounts}
        loading={state.loading}
        mode={view}
      />
    )
  }

  return (
    <div className="app">
      <header className="app__bar">
        <button
          type="button"
          className="app__menu link"
          aria-expanded={navOpen}
          aria-controls="app-nav"
          onClick={() => setNavOpen(!navOpen)}
        >
          {navOpen ? 'Close' : 'Menu'}
        </button>

        <span className="landing__mark">
          <HiveMark size={22} />
          Hive
        </span>

        <div className="app__bar-actions">
          <ThemeToggle />
          <span className="hint app__user">{user.email}</span>
          <button
            type="button"
            className="link icon-btn"
            onClick={() => {
              void api.logout().finally(onSignedOut)
            }}
          >
            <LogoutIcon size={15} />
            Sign out
          </button>
        </div>
      </header>

      <div className="app__body">
        <nav
          id="app-nav"
          className="app__nav"
          data-open={navOpen}
          aria-label="Sections"
        >
          {NAV.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              className="navitem"
              aria-current={view === id ? 'page' : undefined}
              onClick={() => go(id)}
            >
              <Icon size={17} />
              {label}
              {id === 'accounts' && hasAccounts && (
                <span className="navitem__count">{state.accounts.length}</span>
              )}
            </button>
          ))}
        </nav>

        <main className="app__main">{body}</main>
      </div>
    </div>
  )
}

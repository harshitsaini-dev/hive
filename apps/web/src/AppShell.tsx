import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { ConnectedAccount } from '@hive/shared-types'
import { api, ApiRequestError, type User } from './api.js'
import { AccountsView } from './views/AccountsView.js'
import { ComposeView } from './views/ComposeView.js'
import { MailView } from './views/MailView.js'
import { RulesView } from './views/RulesView.js'
import {
  CloseIcon,
  HiveMark,
  LogoutIcon,
  MenuIcon,
  MailIcon,
  PlusIcon,
  ScheduleIcon,
  SearchIcon,
  SendIcon,
  TrashIcon,
} from './Icons.js'
import { CommandPalette } from './CommandPalette.js'
import { EMPTY_FILTERS, type Filters } from './MailFilters.js'
import { StatusScreen } from './StatusScreen.js'
import { ThemeToggle } from './ThemeToggle.js'

export type ViewId = 'inbox' | 'sent' | 'trash' | 'compose' | 'rules' | 'accounts'

const NAV = [
  { id: 'inbox', label: 'Inbox', Icon: MailIcon },
  { id: 'sent', label: 'Sent', Icon: SendIcon },
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
  /*
   * Opens on whatever the URL names, so /accounts is a real destination —
   * the OAuth callback lands there, and a bookmark to it should work.
   * Everything else is in-app state; only this one path is addressable.
   */
  const [view, setView] = useState<ViewId>(() =>
    window.location.pathname === '/accounts' ? 'accounts' : 'inbox',
  )
  const [navOpen, setNavOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  /** Bumped to remount MailView when the palette hands it a new search. */
  const [searchSeed, setSearchSeed] = useState(0)
  const [seededFilters, setSeededFilters] = useState<Filters | undefined>()
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

  /*
   * Ctrl+K, or Cmd+K on a Mac. Registered on the shell rather than inside the
   * palette so it works from any view, and preventDefault stops Chrome's own
   * search-the-page shortcut from firing underneath it.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Choosing a destination on mobile should close the drawer behind you.
  const go = (next: ViewId) => {
    setView(next)
    setNavOpen(false)
    /*
     * Leaving for a nav destination also leaves the palette's search behind.
     * The remount matters: clicking Inbox while already on Inbox changes no
     * key of its own, so without it the seeded text would survive as a filter
     * on top of the folder the user just asked for.
     */
    if (seededFilters) {
      setSeededFilters(undefined)
      setSearchSeed((n) => n + 1)
    }
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
        key={`${view}:${searchSeed}`}
        accounts={state.accounts}
        loading={state.loading}
        mode={view}
        initialFilters={seededFilters}
        everywhere={seededFilters !== undefined}
      />
    )
  }

  return (
    <div className="app">
      <header className="app__bar">
        <button
          type="button"
          className="app__menu"
          aria-expanded={navOpen}
          aria-controls="app-nav"
          aria-label={navOpen ? 'Close menu' : 'Menu'}
          onClick={() => setNavOpen(!navOpen)}
        >
          {/*
            No `.link` class on purpose. It carried one, and a later
            `button.link { display: inline-flex }` rule kept winning the
            specificity contest against every attempt to hide this on desktop
            — so a dead "Menu" button sat in the corner of a layout whose
            sidebar was already fully visible. Its own class, its own rules,
            no contest to lose.
          */}
          {navOpen ? <CloseIcon size={18} /> : <MenuIcon size={18} />}
        </button>

        <span className="landing__mark">
          <HiveMark size={22} />
          Hive
        </span>

        <div className="app__bar-actions">
          {/*
            A visible affordance for the shortcut. A keyboard-only feature is
            a feature most people never discover.
          */}
          <button
            type="button"
            className="searchtrigger"
            onClick={() => setPaletteOpen(true)}
          >
            <SearchIcon size={15} />
            <span className="searchtrigger__label">Search all mail</span>
            <kbd>Ctrl K</kbd>
          </button>

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

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onSeeAll={(text) => {
          // Hand the words to the mail view as a filter, and remount it so the
          // search actually re-runs rather than sitting on stale results.
          setSeededFilters({ ...EMPTY_FILTERS, text })
          setSearchSeed((n) => n + 1)
          setView('inbox')
        }}
      />
    </div>
  )
}

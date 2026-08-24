import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { ConnectedAccount } from '@hive/shared-types'
import { api, ApiRequestError, type User } from './api.js'
import { AccountsView } from './views/AccountsView.js'
import { ComposeView } from './views/ComposeView.js'
import { MailView } from './views/MailView.js'
import { RulesView } from './views/RulesView.js'
import {
  AlertIcon,
  CloseIcon,
  DraftIcon,
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

export type ViewId =
  | 'inbox'
  | 'sent'
  | 'drafts'
  | 'spam'
  | 'trash'
  | 'compose'
  | 'rules'
  | 'accounts'

/** The views that are a list of mail rather than a form or a settings page. */
export type MailboxView = 'inbox' | 'sent' | 'drafts' | 'spam' | 'trash'

/**
 * The view named by the address bar, or the inbox.
 *
 * Only `/accounts` used to be addressable — everything else lived in memory,
 * so reloading anywhere else quietly returned to the inbox.
 */
function viewFromPath(): ViewId {
  const path = window.location.pathname.replace(/^\//, '')
  const known = NAV.some((item) => item.id === path)
  return known ? (path as ViewId) : 'inbox'
}

const NAV = [
  { id: 'inbox', label: 'Inbox', Icon: MailIcon },
  { id: 'sent', label: 'Sent', Icon: SendIcon },
  { id: 'drafts', label: 'Drafts', Icon: DraftIcon },
  /*
   * Spam has its own place rather than being folded into the inbox.
   * Gmail already separates it, every count in this app is built on that
   * separation, and mixing it in would make the inbox — and every analysis
   * drawn from it — mostly a chart of spam.
   */
  { id: 'spam', label: 'Spam', Icon: AlertIcon },
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
  const [view, setView] = useState<ViewId>(() => viewFromPath())
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

  /*
   * Back and Forward move between destinations now that they change the
   * address. Without this the URL would change and the page would not.
   */
  useEffect(() => {
    const onPop = () => setView(viewFromPath())

    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  // Choosing a destination on mobile should close the drawer behind you.
  const go = (next: ViewId) => {
    setView(next)
    // The address bar follows, so a refresh comes back to the same place and
    // Back walks through where you have actually been.
    window.history.pushState({}, '', next === 'inbox' ? '/' : `/${next}`)
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
    body = (
      <RulesView
        accounts={state.accounts}
        loading={state.loading}
        onChanged={refresh}
      />
    )
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

  /*
   * One definition, two homes. See the note where it is placed.
   */
  const session = (
    <>
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
    </>
  )

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

        {/*
          A visible affordance for the shortcut. A keyboard-only feature is a
          feature most people never discover.
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

        {/*
          Theme, identity and sign-out belong in a corner on a desktop and
          nowhere near the top of a phone. Three of them plus a search box
          wrapped the bar onto three lines and pushed the actual mail below
          the fold — so on a narrow screen they move into the drawer, which is
          where the rest of the chrome already lives.

          Rendered in both places and hidden with `display: none`, which takes
          the copy out of the accessibility tree as well as the layout. The
          duplication is real; a single element cannot live under two parents,
          and moving it with JavaScript on resize is worse.
        */}
        <div className="app__bar-actions">{session}</div>
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

          <div className="app__nav-foot">{session}</div>
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

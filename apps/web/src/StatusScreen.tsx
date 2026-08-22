import type { ComponentType, ReactNode } from 'react'
import {
  AlertIcon,
  ArrowLeftIcon,
  HiveMark,
  LockIcon,
  PlugIcon,
  SearchIcon,
  ServerIcon,
} from './Icons.js'
import { ThemeToggle } from './ThemeToggle.js'

export type StatusKind =
  | 'not-found'
  | 'offline'
  | 'server-error'
  | 'access-denied'
  | 'unknown'

interface StatusCopy {
  Icon: ComponentType<{ size?: number }>
  code: string
  title: string
  /** Says what happened and what to do — never just "an error occurred". */
  body: string
  tone: 'neutral' | 'warn' | 'bad'
}

/**
 * Every screen names the actual situation and offers a next step. A page that
 * only says "Error 500" leaves the reader with nothing to do but guess.
 */
const COPY: Record<StatusKind, StatusCopy> = {
  'not-found': {
    Icon: SearchIcon,
    code: '404',
    title: 'That page does not exist',
    body: 'The link may be out of date, or there may be a typo in the address. Nothing is broken on our side.',
    tone: 'neutral',
  },
  offline: {
    Icon: PlugIcon,
    code: 'Offline',
    title: 'You are not connected',
    body: 'Hive reads your mail from Gmail as you go, so it needs a connection. Reconnect and it will pick up where you left off.',
    tone: 'warn',
  },
  'server-error': {
    Icon: ServerIcon,
    code: '500',
    title: 'Something went wrong on our side',
    body: 'This one is our fault, not yours. Nothing in your mailbox was changed. Try again in a moment.',
    tone: 'bad',
  },
  'access-denied': {
    Icon: LockIcon,
    code: '403',
    title: 'You cannot open this',
    body: 'This belongs to a different account, or your session has ended. Signing in again usually sorts it.',
    tone: 'warn',
  },
  unknown: {
    Icon: AlertIcon,
    code: 'Error',
    title: 'Something unexpected happened',
    body: 'Hive could not complete that. Trying again is safe — nothing was half-finished.',
    tone: 'bad',
  },
}

export interface StatusAction {
  label: string
  onClick: () => void
  /** The one the user most likely wants; rendered as the solid button. */
  primary?: boolean
}

export function StatusScreen({
  kind,
  detail,
  actions = [],
  children,
}: {
  kind: StatusKind
  /** Extra specifics — a server message, for instance. Optional. */
  detail?: string | null
  actions?: StatusAction[]
  children?: ReactNode
}) {
  const copy = COPY[kind]

  return (
    <div className="status-screen">
      <header className="landing__bar">
        <span className="landing__mark">
          <HiveMark size={22} />
          Hive
        </span>
        <ThemeToggle />
      </header>

      <main className="shell shell--narrow status-screen__main">
        {/*
          role="alert" would interrupt whatever a screen reader is saying.
          These screens replace the whole page, so the heading being reachable
          is enough — status is polite by design.
        */}
        <div className="status-screen__card" role="status">
          <span className={`status-screen__icon status-screen__icon--${copy.tone}`}>
            <copy.Icon size={26} />
          </span>

          <p className="status-screen__code">{copy.code}</p>
          <h1>{copy.title}</h1>
          <p className="hint">{copy.body}</p>

          {detail && <p className="status-screen__detail">{detail}</p>}

          {actions.length > 0 && (
            <div className="status-screen__actions">
              {actions.map((action) => (
                <button
                  key={action.label}
                  type="button"
                  className={action.primary ? undefined : 'link'}
                  onClick={action.onClick}
                >
                  {action.primary ? null : <ArrowLeftIcon size={15} />}
                  {action.label}
                </button>
              ))}
            </div>
          )}

          {children}
        </div>
      </main>
    </div>
  )
}

import { Component, type ErrorInfo, type ReactNode } from 'react'
import { StatusScreen } from './StatusScreen.js'

interface State {
  error: Error | null
}

/**
 * Catches render-time crashes so a thrown component shows an explanation
 * rather than a blank white page — which is what React does by default, and
 * which is indistinguishable from the app failing to load at all.
 *
 * Still a class: React has no hook equivalent of componentDidCatch.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Kept in the console for local debugging. Wire to error reporting when
    // there is somewhere to send it.
    console.error('render error:', error, info.componentStack)
  }

  override render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <StatusScreen
        kind="server-error"
        // Only in development: a stack or message can name internal paths, and
        // there is nothing a user can do with it anyway.
        detail={import.meta.env.DEV ? error.message : null}
        actions={[
          {
            label: 'Reload the page',
            primary: true,
            onClick: () => window.location.reload(),
          },
        ]}
      />
    )
  }
}

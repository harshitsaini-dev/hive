import { useEffect, useState } from 'react'
import { CheckIcon, DownloadIcon } from './Icons.js'

/**
 * Chrome's install prompt event. Not in the DOM lib because it is not a
 * standard — Safari and Firefox never fire it, which is why the button hides
 * itself rather than offering something that would do nothing.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS Safari predates the standard and reports it here instead.
    (navigator as { standalone?: boolean }).standalone === true
  )
}

export function InstallButton({ className }: { className?: string }) {
  const [prompt, setPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [installed, setInstalled] = useState(isStandalone)

  useEffect(() => {
    const onAvailable = (event: Event) => {
      // Chrome shows its own mini-infobar unless the default is prevented;
      // holding the event lets the page decide where the button lives.
      event.preventDefault()
      setPrompt(event as BeforeInstallPromptEvent)
    }

    const onInstalled = () => {
      setInstalled(true)
      setPrompt(null)
    }

    window.addEventListener('beforeinstallprompt', onAvailable)
    window.addEventListener('appinstalled', onInstalled)

    return () => {
      window.removeEventListener('beforeinstallprompt', onAvailable)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  if (installed) {
    return (
      <span className="install-badge">
        <CheckIcon size={15} />
        Installed
      </span>
    )
  }

  // No prompt means the browser will not install: already installed, not
  // eligible yet, or a browser that does not support it at all. A button that
  // cannot do anything is worse than no button.
  if (!prompt) return null

  return (
    <button
      type="button"
      className={className ? `icon-btn ${className}` : 'icon-btn'}
      onClick={() => {
        void (async () => {
          await prompt.prompt()
          const { outcome } = await prompt.userChoice
          // The event is single-use either way — Chrome fires a fresh one if
          // the user becomes eligible again.
          setPrompt(null)
          if (outcome === 'accepted') setInstalled(true)
        })()
      }}
    >
      <DownloadIcon size={16} />
      Install app
    </button>
  )
}

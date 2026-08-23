import { useEffect, useState } from 'react'
import { CheckIcon, DownloadIcon } from './Icons.js'

/**
 * Chrome's install prompt event. Not in the DOM lib because it is not a
 * standard, and that is the whole problem this component works around.
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

type Platform = 'ios' | 'safari' | 'firefox' | 'other'

/**
 * Which set of instructions to show when the browser will not do it for us.
 *
 * User-agent sniffing, which is normally the wrong tool — here it is picking
 * a sentence to display, not gating a feature, so being wrong costs a reader
 * a moment's confusion rather than access to anything.
 */
function detectPlatform(): Platform {
  const ua = navigator.userAgent

  if (/iPhone|iPad|iPod/.test(ua)) return 'ios'
  if (/Firefox\//.test(ua)) return 'firefox'
  if (/Safari\//.test(ua) && !/Chrome|Chromium|Edg\//.test(ua)) return 'safari'
  return 'other'
}

const INSTRUCTIONS: Record<Platform, { title: string; steps: string[] }> = {
  ios: {
    title: 'Add Hive to your Home Screen',
    steps: [
      'Tap the Share button at the bottom of Safari.',
      'Scroll down and choose “Add to Home Screen”.',
      'Tap Add. Hive opens like any other app, full screen.',
    ],
  },
  safari: {
    title: 'Add Hive to your Dock',
    steps: [
      'Open the File menu in Safari.',
      'Choose “Add to Dock”.',
      'Hive opens in its own window, without browser chrome.',
    ],
  },
  firefox: {
    title: 'Firefox cannot install web apps',
    steps: [
      'Firefox removed this feature on desktop and does not offer it on Android.',
      'Chrome, Edge and Safari can all install Hive.',
      'Everything works in Firefox regardless — installing only changes how it opens.',
    ],
  },
  other: {
    title: 'Install Hive from the address bar',
    steps: [
      'Look for the install icon at the right of the address bar.',
      'Or open the browser menu and choose “Install Hive”.',
      'It then opens in its own window, without tabs or an address bar.',
    ],
  },
}

/**
 * The prompt caught in `index.html`, before this component existed.
 *
 * Chrome fires `beforeinstallprompt` once and early — routinely before the
 * bundle has parsed. A listener registered in an effect misses it, and the
 * button then offers manual instructions to exactly the people whose browser
 * would have installed in one click.
 */
function heldPrompt(): BeforeInstallPromptEvent | null {
  return (
    (window as { __hiveInstallPrompt?: BeforeInstallPromptEvent | null })
      .__hiveInstallPrompt ?? null
  )
}

/**
 * Offers to install Hive as an app.
 *
 * **It no longer hides when it cannot do the job itself.** The previous
 * version rendered nothing unless Chrome had fired `beforeinstallprompt`,
 * which sounded principled — a button that does nothing is worse than no
 * button — and meant that on Safari, on Firefox, and on every iPhone, the
 * feature simply did not appear to exist. Hive is installable on all of them;
 * only the *mechanism* differs, and a browser that will not offer a one-click
 * install is exactly the case where someone needs telling how.
 *
 * So: one click where the browser supports it, and the three steps that do
 * work where it does not.
 */
export function InstallButton({
  className,
  label = 'Install app',
}: {
  className?: string
  label?: string
}) {
  const [prompt, setPrompt] = useState<BeforeInstallPromptEvent | null>(
    heldPrompt,
  )
  const [installed, setInstalled] = useState(isStandalone)
  const [showing, setShowing] = useState(false)

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
      setShowing(false)
    }

    // Both: the native event in case it fires late, and the signal from the
    // head script for the far more common case where it already has.
    const onHeld = () => setPrompt(heldPrompt())

    window.addEventListener('beforeinstallprompt', onAvailable)
    window.addEventListener('hive:installable', onHeld)
    window.addEventListener('appinstalled', onInstalled)

    return () => {
      window.removeEventListener('beforeinstallprompt', onAvailable)
      window.removeEventListener('hive:installable', onHeld)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  useEffect(() => {
    if (!showing) return

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowing(false)
    }

    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [showing])

  // Already an app. Saying so is friendlier than a button that reinstalls it.
  if (installed) {
    return (
      <span className="install-badge">
        <CheckIcon size={15} />
        Installed
      </span>
    )
  }

  const platform = detectPlatform()
  const guide = INSTRUCTIONS[platform]

  async function install() {
    if (!prompt) {
      setShowing(true)
      return
    }

    await prompt.prompt()
    const { outcome } = await prompt.userChoice
    // Single-use either way — Chrome fires a fresh one if the user becomes
    // eligible again.
    setPrompt(null)
    ;(window as { __hiveInstallPrompt?: unknown }).__hiveInstallPrompt = null
    if (outcome === 'accepted') setInstalled(true)
  }

  return (
    <>
      <button
        type="button"
        className={className ? `icon-btn ${className}` : 'icon-btn'}
        onClick={() => void install()}
      >
        <DownloadIcon size={16} />
        {label}
      </button>

      {showing && (
        <div
          className="modal-backdrop"
          onClick={(event) => {
            if (event.target === event.currentTarget) setShowing(false)
          }}
        >
          <div
            className="modal install-guide"
            role="dialog"
            aria-modal="true"
            aria-labelledby="install-title"
          >
            <span className="status-screen__icon status-screen__icon--neutral">
              <DownloadIcon size={24} />
            </span>

            <h2 id="install-title">{guide.title}</h2>

            <ol className="install-guide__steps">
              {guide.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>

            <div className="modal__actions">
              <button type="button" onClick={() => setShowing(false)}>
                Got it
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

/**
 * Registers the service worker that makes Hive installable.
 *
 * Only in a production build: in development Vite serves modules unbundled and
 * a caching worker turns "why is my edit not showing" into a daily occurrence.
 * The install prompt is a production concern anyway.
 */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return

  if (import.meta.env.DEV) {
    // Clean up after anyone who ran a production build on this origin first —
    // otherwise a stale worker keeps serving cached assets over the dev server.
    void navigator.serviceWorker
      .getRegistrations()
      .then((registrations) =>
        Promise.all(registrations.map((registration) => registration.unregister())),
      )
      .catch(() => {
        // Nothing to clean up, or the browser refused. Either is fine.
      })
    return
  }

  // After load, so registration never competes with first paint.
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch((error: unknown) => {
      console.warn('service worker registration failed:', error)
    })
  })
}

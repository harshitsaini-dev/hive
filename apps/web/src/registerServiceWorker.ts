/**
 * Registers the service worker that makes Hive installable.
 *
 * Registered in development too, so the install prompt can be tried on the dev
 * server without a separate production build. The worker itself refuses to
 * cache Vite's dev-only URLs (see sw.js), which is what keeps edits showing up.
 * If something does go stale, a hard reload clears it.
 */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return

  // After load, so registration never competes with first paint.
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch((error: unknown) => {
      console.warn('service worker registration failed:', error)
    })
  })
}

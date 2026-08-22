/**
 * Service worker for Hive.
 *
 * Scope is deliberately narrow. This caches the app shell so the installed PWA
 * opens instantly and can say something sensible when offline — it does NOT
 * cache API responses. Mail metadata is per-user and changes constantly;
 * serving a stale copy of someone's inbox from disk would be both confusing
 * and a privacy problem on a shared device.
 */

// Bump on every deploy that changes the shell, or old caches are served.
const CACHE = 'hive-shell-v1'

const SHELL = ['/', '/index.html', '/offline.html', '/icons/icon-192.png']

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE)
      // Individually, so one 404 does not abort the whole install.
      await Promise.allSettled(SHELL.map((url) => cache.add(url)))
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(
        names.filter((name) => name !== CACHE).map((name) => caches.delete(name)),
      )
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event

  if (request.method !== 'GET') return

  const url = new URL(request.url)

  // Same-origin only. Anything else is Google's, and not ours to intercept.
  if (url.origin !== self.location.origin) return

  /**
   * Never touch the API. Auth state, account lists and message metadata must
   * always come from the server — a cached 200 here could show one user data
   * belonging to whoever was signed in before.
   */
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws')) return

  /**
   * Vite's dev server URLs are never cached.
   *
   * The worker is registered in development so the install prompt can be tried
   * without a separate production build, but dev modules are unhashed — a
   * cache-first hit on /src/App.tsx would serve yesterday's code and look like
   * the edit simply did not apply.
   */
  if (
    url.pathname.startsWith('/@') ||
    url.pathname.startsWith('/src/') ||
    url.pathname.startsWith('/node_modules/') ||
    url.searchParams.has('t') ||
    url.searchParams.has('import')
  ) {
    return
  }

  // Navigations: network first, so a deploy is picked up immediately. The
  // cache is the fallback that makes the installed app work offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request)
          const cache = await caches.open(CACHE)
          cache.put('/index.html', response.clone())
          return response
        } catch {
          return (
            (await caches.match('/index.html')) ??
            (await caches.match('/offline.html')) ??
            new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } })
          )
        }
      })(),
    )
    return
  }

  // Static assets: cache first. Vite fingerprints filenames, so a cached hit
  // is always the right content for that URL.
  event.respondWith(
    (async () => {
      const cached = await caches.match(request)
      if (cached) return cached

      try {
        const response = await fetch(request)
        if (response.ok && response.type === 'basic') {
          const cache = await caches.open(CACHE)
          cache.put(request, response.clone())
        }
        return response
      } catch {
        return new Response('', { status: 504 })
      }
    })(),
  )
})

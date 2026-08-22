import { useEffect, useState } from 'react'

type Health =
  | { state: 'checking' }
  | { state: 'up'; env: string }
  | { state: 'down'; reason: string }

/**
 * Placeholder shell. Its one real job right now is to prove the dev proxy
 * reaches the API — which is the thing most likely to be quietly misconfigured
 * before any feature work starts.
 */
export function App() {
  const [health, setHealth] = useState<Health>({ state: 'checking' })

  useEffect(() => {
    const abort = new AbortController()

    fetch('/api/health', { signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json() as Promise<{ status: string; env: string }>
      })
      .then((body) => setHealth({ state: 'up', env: body.env }))
      .catch((error: unknown) => {
        if (abort.signal.aborted) return
        setHealth({
          state: 'down',
          reason: error instanceof Error ? error.message : 'unreachable',
        })
      })

    return () => abort.abort()
  }, [])

  return (
    <main className="shell">
      <h1>Hive</h1>
      <p className="tagline">Manage several Gmail accounts from one place.</p>

      <section className="status" aria-live="polite">
        {health.state === 'checking' && <p>Checking the API…</p>}
        {health.state === 'up' && (
          <p className="ok">API reachable — running in {health.env}.</p>
        )}
        {health.state === 'down' && (
          <p className="bad">
            API unreachable ({health.reason}). Is the server running on port
            3000?
          </p>
        )}
      </section>
    </main>
  )
}

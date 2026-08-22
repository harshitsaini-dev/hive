import { useEffect, useState } from 'react'

/**
 * Whether the browser thinks it has a connection.
 *
 * `navigator.onLine` is only ever trustworthy when false — true means "a
 * network interface exists", not "the internet is reachable". So this is used
 * to show the offline screen, never to conclude that a request will succeed.
 */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine)

  useEffect(() => {
    const goOnline = () => setOnline(true)
    const goOffline = () => setOnline(false)

    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)

    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [])

  return online
}

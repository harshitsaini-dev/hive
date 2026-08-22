import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Local development TLS.
 *
 * Not a nicety: Google refuses to attach the restricted
 * `https://mail.google.com/` scope to an OAuth client that has any non-HTTPS
 * redirect URI, `http://localhost` included. So the dev server has to speak
 * TLS for permanent delete to be testable at all.
 *
 * Certificates come from scripts/make-cert.sh and live in .certs/ (gitignored).
 * In production the platform terminates TLS, so this returns null there and
 * the app listens over plain HTTP behind the proxy.
 */
export function loadDevTls(): { key: Buffer; cert: Buffer } | null {
  if (process.env.NODE_ENV === 'production') return null
  if (process.env.HIVE_DISABLE_TLS === '1') return null

  const dir = join(process.cwd(), '..', '..', '.certs')

  try {
    return {
      key: readFileSync(join(dir, 'localhost.key')),
      cert: readFileSync(join(dir, 'localhost.crt')),
    }
  } catch {
    // Missing certificates are not fatal — the app still runs over HTTP, it
    // just cannot complete an OAuth flow that includes the restricted scope.
    return null
  }
}

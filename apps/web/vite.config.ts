import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Local TLS, from scripts/make-cert.sh.
 *
 * Required rather than optional: Google will not attach the restricted
 * https://mail.google.com/ scope to an OAuth client with any non-HTTPS
 * redirect URI, so the whole local flow has to run over TLS.
 */
function devHttps() {
  const dir = resolve(__dirname, '../../.certs')
  try {
    return {
      key: readFileSync(resolve(dir, 'localhost.key')),
      cert: readFileSync(resolve(dir, 'localhost.crt')),
    }
  } catch {
    return undefined
  }
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    https: devHttps(),
    // The API is same-origin in the browser during dev, so cookies behave the
    // way they will in production rather than needing SameSite workarounds.
    proxy: {
      '/api': {
        target: process.env.VITE_API_BASE_URL ?? 'https://localhost:3000',
        changeOrigin: true,
        // Our own local CA is not in Node's trust store.
        secure: false,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
      '/ws': {
        target: process.env.VITE_API_BASE_URL ?? 'https://localhost:3000',
        ws: true,
        secure: false,
      },
    },
  },
})

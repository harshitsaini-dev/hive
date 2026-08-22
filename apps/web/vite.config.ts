import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The API is same-origin in the browser during dev, so cookies behave the
    // way they will in production rather than needing SameSite workarounds.
    proxy: {
      '/api': {
        target: process.env.VITE_API_BASE_URL ?? 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
      '/ws': {
        target: process.env.VITE_API_BASE_URL ?? 'http://localhost:3000',
        ws: true,
      },
    },
  },
})

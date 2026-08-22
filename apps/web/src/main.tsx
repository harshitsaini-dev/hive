import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { ErrorBoundary } from './ErrorBoundary.js'
import { ThemeProvider } from './theme.js'
import { registerServiceWorker } from './registerServiceWorker.js'
import './styles.css'

const container = document.getElementById('root')
if (!container) throw new Error('#root missing from index.html')

registerServiceWorker()

createRoot(container).render(
  <StrictMode>
    <ThemeProvider>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </ThemeProvider>
  </StrictMode>,
)

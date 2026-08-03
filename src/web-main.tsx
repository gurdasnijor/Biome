// Web entry point. Installs the browser `window.electronAPI` shim BEFORE any
// renderer module that might reach for it, then boots the exact same <App/>
// used by the Electron desktop client.
import './web/installElectronShim'

import React from 'react'
import ReactDOM from 'react-dom/client'
import './i18n'
import App from './App'
import './css/app.css'

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('Root element #root was not found')
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

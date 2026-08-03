import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

// Standalone web build of the Biome renderer (no Electron). Produces a static
// SPA in `dist-web/` that talks to a remote Biome server over HTTP + WebSocket.
// Point it at a server with `VITE_BIOME_SERVER_URL` at build time, e.g.:
//   VITE_BIOME_SERVER_URL=https://biome.example.com npm run build:web
export default defineConfig({
  plugins: [tailwindcss(), react()],
  publicDir: 'public',
  base: '/',
  build: {
    outDir: 'dist-web',
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'index.web.html'),
      output: {
        manualChunks: (id) => {
          if (id.includes('node_modules')) return 'vendor'
        }
      }
    }
  }
})

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev-server proxy: the SPA calls relative /api/* and /login etc. paths so cookies work
// same-origin. In dev, Vite runs on its own port (5173) and the backend (npm run
// ingatlan:webapp) runs separately on INGATLAN_WEBAPP_PORT (default 8788) -- the proxy makes
// those relative calls reach the real backend without a CORS dance. In production the built
// static files are served BY the webapp server itself (webapp-server.ts's serveDashboard hook),
// so no proxy is involved at all -- same-origin natively.
const BACKEND_PORT = process.env.INGATLAN_WEBAPP_PORT || '8788'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': `http://127.0.0.1:${BACKEND_PORT}`,
      '/login': `http://127.0.0.1:${BACKEND_PORT}`,
      '/logout': `http://127.0.0.1:${BACKEND_PORT}`,
      '/auth': `http://127.0.0.1:${BACKEND_PORT}`,
    },
  },
  build: {
    outDir: 'dist',
  },
})

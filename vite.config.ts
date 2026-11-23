import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'

// Fetches remote .ics calendars server-side so the browser never has to make
// a cross-origin request (which calendar providers typically block via CORS).
function icsProxyPlugin(): Plugin {
  return {
    name: 'ics-proxy',
    configureServer(server) {
      server.middlewares.use('/api/ics-proxy', async (req, res) => {
        const requestUrl = new URL(req.url ?? '', 'http://localhost')
        const targetUrl = requestUrl.searchParams.get('url')

        if (!targetUrl) {
          res.statusCode = 400
          res.end('Missing "url" query parameter')
          return
        }

        let parsed: URL
        try {
          parsed = new URL(targetUrl.replace(/^webcal:\/\//i, 'https://'))
        } catch {
          res.statusCode = 400
          res.end('Invalid calendar URL')
          return
        }

        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          res.statusCode = 400
          res.end('Calendar URL must use HTTP or HTTPS')
          return
        }

        try {
          const response = await fetch(parsed)
          if (!response.ok) {
            res.statusCode = response.status
            res.end(`Calendar fetch failed with status ${response.status}`)
            return
          }
          res.setHeader('Content-Type', 'text/calendar; charset=utf-8')
          res.end(await response.text())
        } catch (err) {
          res.statusCode = 502
          res.end(err instanceof Error ? err.message : 'Failed to fetch calendar')
        }
      })
    },
  }
}

// The ServiceUNSW backend handles accounts, sign-in, email verification and
// each account's saved portal data.
// By default the dev server proxies `/v1` to the Development deployment on AWS;
// set SERVICEUNSW_API_URL (e.g. in .env.local) to use a local backend instead.
// Hosted builds don't use this proxy: they read /runtime-config.json.
function backendProxy(target: string) {
  return { '/v1': { target, changeOrigin: true, secure: true } }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const backendUrl = env.SERVICEUNSW_API_URL || 'https://api.dev.serviceunsw.com'
  return {
    plugins: [react(), icsProxyPlugin()],
    server: {
      proxy: backendProxy(backendUrl),
    },
    preview: {
      proxy: backendProxy(backendUrl),
    },
  }
})

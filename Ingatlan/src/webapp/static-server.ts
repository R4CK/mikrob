import { createReadStream, existsSync, statSync } from 'node:fs'
import { join, extname, resolve, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

// Serves the built SPA (Ingatlan/frontend/dist) as the webapp-server's `serveDashboard` hook
// (card 65e96a20, closing the extension point 426da6c1 left open). Only reachable AFTER the
// session check in webapp-server.ts -- this file adds no auth of its own, and must not: its own
// job is exactly the path-traversal guard below, nothing more.
export function createStaticFileServer(rootDir: string): (req: IncomingMessage, res: ServerResponse) => void {
  const root = resolve(rootDir)

  return (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    let requestedPath: string
    try {
      requestedPath = decodeURIComponent(url.pathname)
    } catch {
      res.writeHead(400)
      res.end('bad request')
      return
    }
    if (requestedPath === '/' || requestedPath === '') requestedPath = '/index.html'

    // Path-traversal guard: the resolved path must stay INSIDE root. `resolve` collapses `..`
    // segments before this check runs, so "/../../etc/passwd" cannot escape by construction --
    // this is the check that actually enforces it, not decoration.
    const resolved = resolve(join(root, requestedPath))
    if (resolved !== root && !resolved.startsWith(root + sep)) {
      res.writeHead(403)
      res.end('forbidden')
      return
    }

    let filePath = resolved
    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      // SPA fallback: any unknown path (a future client-side route) gets index.html, same as
      // every standard SPA static host. A file that legitimately does not exist inside dist
      // (a typo'd asset path) also falls back here rather than a bare 404 -- acceptable for a
      // single-user local tool where "404" and "index.html" both just mean "check the URL".
      filePath = join(root, 'index.html')
    }
    if (!existsSync(filePath)) {
      res.writeHead(404)
      res.end('not found -- frontend not built yet (npm run -w Ingatlan/frontend build)')
      return
    }

    const type = MIME[extname(filePath)] ?? 'application/octet-stream'
    res.writeHead(200, { 'Content-Type': type })
    createReadStream(filePath).pipe(res)
  }
}

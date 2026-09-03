import { createReadStream, existsSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

const UI_DIST = join(fileURLToPath(import.meta.url), '..', '..', '..', '..', 'ui', 'dist')

export function serveStatic(req: IncomingMessage, res: ServerResponse): boolean {
  const url = req.url ?? '/'
  const isAPI = url.startsWith('/api/') || url === '/ws'
  if (isAPI) {
    return false
  }

  let fsPath = join(UI_DIST, url === '/' ? 'index.html' : url)

  if (!existsSync(fsPath)) {
    fsPath = join(UI_DIST, 'index.html')
  }

  if (!existsSync(fsPath)) {
    res.writeHead(404)
    res.end('Not found')
    return true
  }

  const ext = extname(fsPath)
  res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' })
  createReadStream(fsPath).pipe(res)
  return true
}

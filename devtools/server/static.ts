import { createReadStream, existsSync, realpathSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'
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
const UI_DIST_REAL = realpathSync.native(UI_DIST)

export function serveStatic(req: IncomingMessage, res: ServerResponse): boolean {
  const rawUrl = req.url ?? '/'
  const isAPI = rawUrl.startsWith('/api/') || rawUrl === '/ws'
  if (isAPI) {
    return false
  }

  let pathname = '/'
  try {
    pathname = new URL(rawUrl, 'http://localhost').pathname
    pathname = decodeURIComponent(pathname)
  } catch {
    res.writeHead(400)
    res.end('Bad request')
    return true
  }

  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^[/\\]+/, '')
  let fsPath = resolve(UI_DIST, relativePath)

  try {
    fsPath = realpathSync.native(fsPath)
  } catch {
    fsPath = resolve(UI_DIST, 'index.html')
  }

  if (!(fsPath === UI_DIST_REAL || fsPath.startsWith(UI_DIST_REAL + sep))) {
    res.writeHead(404)
    res.end('Not found')
    return true
  }

  if (!existsSync(fsPath)) {
    fsPath = resolve(UI_DIST, 'index.html')
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

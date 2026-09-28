import { createReadStream, existsSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { serveStatic } from './static.js'

vi.mock('node:fs', () => ({ existsSync: vi.fn(), createReadStream: vi.fn() }))

const root = join(fileURLToPath(import.meta.url), '..', '..', '..', '..', 'ui', 'dist')

afterEach(() => vi.resetAllMocks())

function request(url: string) {
  const res = { writeHead: vi.fn(), end: vi.fn() }
  const handled = serveStatic({ url } as IncomingMessage, res as unknown as ServerResponse)
  return { ...res, handled }
}

describe('serveStatic', () => {
  it.each(['/../secret.txt', '/assets/../../secret.txt', '/../dist-private/secret.txt', '/..'])(
    'rejects %s before checking or reading files outside the UI directory',
    url => {
      const res = request(url)
      expect(res.handled).toBe(true)
      expect(res.writeHead).toHaveBeenCalledWith(404)
      expect(res.end).toHaveBeenCalledWith('Not found')
      expect(existsSync).not.toHaveBeenCalled()
      expect(createReadStream).not.toHaveBeenCalled()
    },
  )

  it('serves a nested asset within the UI directory', () => {
    vi.mocked(existsSync).mockReturnValue(true)
    const pipe = vi.fn()
    vi.mocked(createReadStream).mockReturnValue({ pipe } as never)

    const res = request('/assets/app.js')

    expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/javascript' })
    expect(createReadStream).toHaveBeenCalledWith(join(root, 'assets/app.js'))
    expect(pipe).toHaveBeenCalledTimes(1)
  })

  it('keeps the index fallback for client-side routes', () => {
    vi.mocked(existsSync).mockReturnValueOnce(false).mockReturnValueOnce(true)
    vi.mocked(createReadStream).mockReturnValue({ pipe: vi.fn() } as never)

    const res = request('/dashboard')

    expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'text/html' })
    expect(createReadStream).toHaveBeenCalledWith(join(root, 'index.html'))
  })

  it('returns 404 when the UI is not built', () => {
    vi.mocked(existsSync).mockReturnValue(false)
    expect(request('/').writeHead).toHaveBeenCalledWith(404)
    expect(createReadStream).not.toHaveBeenCalled()
  })

  it.each(['/api/routes', '/ws'])('leaves %s to the server', url => {
    expect(request(url).handled).toBe(false)
    expect(existsSync).not.toHaveBeenCalled()
  })
})

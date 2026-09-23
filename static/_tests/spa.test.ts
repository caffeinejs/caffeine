import { describe, expect, it } from 'vitest'

import { immutableAssets, isDocumentRequest, spaMount } from '../spa.js'

/** A request as `isDocumentRequest` reads one: a URL and whatever headers the client sent. */
const request = (url: string, headers: Record<string, string> = {}) => ({
  req: { url, header: (key: string) => headers[key] },
})

const NAVIGATION = {
  accept: 'text/html,application/xhtml+xml',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
}
const XHR = { accept: 'application/json', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }
const CURL = { accept: '*/*' }

describe('isDocumentRequest', () => {
  it('answers a browser navigation', () => {
    expect(isDocumentRequest(request('/settings', NAVIGATION))).toBe(true)
  })

  it('answers a framed document, whose destination is not `document`', () => {
    expect(isDocumentRequest(request('/settings', { ...NAVIGATION, 'sec-fetch-dest': 'iframe' }))).toBe(true)
  })

  it('refuses a programmatic fetch, even when it asks for HTML', () => {
    expect(isDocumentRequest(request('/settings', { ...XHR, accept: 'text/html' }))).toBe(false)
  })

  // `*/*` is what curl, axios and kube-probe send, and none of them can do anything with a document.
  it('does not take a bare wildcard Accept for a document request', () => {
    expect(isDocumentRequest(request('/settings', CURL))).toBe(false)
  })

  // A client that said nothing has not refused either, so a test or a tool sending no headers sees the page.
  it('answers a request that says nothing about what it wants', () => {
    expect(isDocumentRequest(request('/settings'))).toBe(true)
  })

  // This is what keeps a missing hashed asset a real 404 instead of HTML under a JavaScript content type.
  it('refuses a path naming a file, whatever the client asked for', () => {
    expect(isDocumentRequest(request('/assets/app-eZr2sdaR.js', NAVIGATION))).toBe(false)
    expect(isDocumentRequest(request('/favicon.ico', NAVIGATION))).toBe(false)
  })

  it('allows .html through, since /about.html is a plausible client route', () => {
    expect(isDocumentRequest(request('/about.html', NAVIGATION))).toBe(true)
  })

  it('reads the path without its query', () => {
    expect(isDocumentRequest(request('/settings?tab=app.js', NAVIGATION))).toBe(true)
    expect(isDocumentRequest(request('/app.js?v=2', NAVIGATION))).toBe(false)
  })

  it('takes a dotfile and a trailing dot for a path, not a file name', () => {
    expect(isDocumentRequest(request('/.well-known', NAVIGATION))).toBe(true)
    expect(isDocumentRequest(request('/', NAVIGATION))).toBe(true)
  })

  it('answers anything that names no file when navigationOnly is off', () => {
    expect(isDocumentRequest(request('/settings', CURL), false)).toBe(true)
    expect(isDocumentRequest(request('/assets/app.js', CURL), false)).toBe(false)
  })
})

describe('spaMount', () => {
  // `wildcard: false` is load-bearing: the default catch-all collides with the application's own.
  it('turns the wildcard off and keeps the shell document off the mount', () => {
    expect(spaMount()).toEqual({
      wildcard: false,
      index: false,
      globIgnore: ['index.html', '**/*.br', '**/*.gz', '**/*.deflate'],
    })
  })

  it('ignores the document it was told about', () => {
    expect(spaMount('app.html').globIgnore).toContain('app.html')
    expect(spaMount('app.html').globIgnore).not.toContain('index.html')
  })

  // `preCompressed` finds these on the file system, so routing them would only expose the raw bytes.
  it('keeps the compressed siblings off the mount, for every encoding @fastify/static tries', () => {
    expect(spaMount().globIgnore).toEqual(expect.arrayContaining(['**/*.br', '**/*.gz', '**/*.deflate']))
  })
})

describe('immutableAssets', () => {
  const header = (root: string, path: string, prefixes?: readonly string[]) => {
    let value: string | undefined
    immutableAssets(root, prefixes)(
      { header: (_: string, v: string) => (value = v) } as never,
      path,
      undefined as never,
    )

    return value
  }

  it('pins a content-hashed asset and revalidates everything else', () => {
    expect(header('/site', '/site/assets/app-eZr2sdaR.js')).toBe('public, max-age=31536000, immutable')
    expect(header('/site', '/site/index.html')).toBe('public, max-age=3600')
  })

  // `/assets` means the site's assets directory, not any directory of that name higher up the filesystem.
  it('compares within the root', () => {
    expect(header('/srv/assets/site', '/srv/assets/site/main.js')).toBe('public, max-age=3600')
  })

  it('leaves a file outside the root alone', () => {
    expect(header('/site', '/elsewhere/app.js')).toBeUndefined()
  })

  it('takes the prefixes it is given', () => {
    expect(header('/site', '/site/static/app.js', ['/static'])).toBe('public, max-age=31536000, immutable')
  })
})

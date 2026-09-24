import { describe, expect, it } from 'vitest'

import { rebaseDirectoryRedirect } from './_redirect.js'

describe('rebaseDirectoryRedirect', () => {
  // `@fastify/static` builds a directory redirect from the URL the base was taken off, so that one gets it back.
  it.each([
    ['/dir/', '/dir', '/api/dir/'],
    ['/dir/?x=1', '/dir?x=1', '/api/dir/?x=1'],
    ['/dir/', '//dir', '/api/dir/'],
  ])('puts the base in front of the directory redirect %s for %s', (location, url, expected) => {
    expect(rebaseDirectoryRedirect(location, 301, url, '/api')).toBe(expected)
  })

  // Anything else on the same reply was built by someone who knew the base, or chose to write it without one.
  it.each([
    ['the sign-in challenge, which carries the base already', '/api/login?returnUrl=%2Fapi%2Fx', 302, '/x'],
    ["an application's own redirect, even sent as a 301", '/api/done', 301, '/x'],
    ['a redirect to the directory form that is not a 301', '/dir/', 302, '/dir'],
  ])('leaves %s alone', (_, location, status, url) => {
    expect(rebaseDirectoryRedirect(location, status, url, '/api')).toBe(location)
  })

  it('leaves a request that came without the base without one', () => {
    expect(rebaseDirectoryRedirect('/dir/', 301, '/dir', '')).toBe('/dir/')
  })
})

import { fc, it } from '@fast-check/vitest'
import { describe, expect } from 'vitest'

import { resolveAppURL, stripBasePath } from './base_path.js'

/**
 * The invariants of taking a base path off a request, over bases, paths and queries no one wrote down.
 *
 * Segments are drawn from characters that are legal in a path and include the ones that could confuse a naive
 * prefix check — `.`, `-`, `%`, and letters that share a start with the base.
 */
const segment = fc.stringMatching(/^[A-Za-z0-9._~%-]{1,8}$/)
const base = fc.array(segment, { minLength: 1, maxLength: 3 }).map(segments => `/${segments.join('/')}`)
const path = fc.array(segment, { maxLength: 4 }).map(segments => `/${segments.join('/')}`)
const query = fc.oneof(
  fc.constant(''),
  fc.stringMatching(/^[A-Za-z0-9=&/?%._~-]{0,12}$/).map(rest => `?${rest}`),
)

describe('stripBasePath (property)', () => {
  it.prop([base, path, query])('gives back exactly the path and query behind the base', (b, p, q) => {
    expect(stripBasePath(b + p + q, b)).toBe(p + q)
  })

  it.prop([base, query])('makes the base alone the root, keeping its query', (b, q) => {
    expect(stripBasePath(b + q, b)).toBe(`/${q}`)
  })

  it.prop([base, fc.string()])('always gives back a path when it takes the base off', (b, rest) => {
    const stripped = stripBasePath(b + rest, b)

    if (stripped !== undefined) {
      expect(stripped.startsWith('/')).toBe(true)
    }
  })

  it.prop([base, path, query])('never alters the query string', (b, p, q) => {
    const url = b + p + q

    expect(queryOf(stripBasePath(url, b)!)).toBe(queryOf(url))
  })

  it.prop([base, fc.string({ minLength: 1 })])(
    'takes nothing when the base does not end on a segment boundary',
    (b, rest) => {
      fc.pre(rest[0] !== '/' && rest[0] !== '?')

      expect(stripBasePath(b + rest, b)).toBeUndefined()
    },
  )

  it.prop([base, fc.string()])('takes nothing from a URL that does not start with the base', (b, url) => {
    fc.pre(!url.startsWith(b))

    expect(stripBasePath(url, b)).toBeUndefined()
  })
})

describe('resolveAppURL (property)', () => {
  const maybeBase = fc.oneof(fc.constant(''), base)

  it.prop([maybeBase, path, query])('puts the base in front of a path written with "~/"', (b, p, q) => {
    expect(resolveAppURL(`~${p}${q}`, b)).toBe(`${b}${p}${q}`)
  })

  // A browser drops tabs and line breaks before it reads a URL, so they count as not being there.
  it.prop([maybeBase, fc.string()])('never gives back a URL a browser reads as protocol-relative', (b, rest) => {
    const resolved = resolveAppURL(`~/${rest}`, b).replace(/[\t\n\r]/g, '')

    expect(resolved.startsWith('//') || resolved.startsWith('/\\')).toBe(false)
  })

  it.prop([maybeBase, fc.string()])('returns anything not starting with "~/" as it is', (b, url) => {
    fc.pre(!url.startsWith('~/'))

    expect(resolveAppURL(url, b)).toBe(url)
  })
})

/** Everything from the first "?" on, or `''` when there is no query. */
function queryOf(url: string): string {
  const at = url.indexOf('?')
  return at === -1 ? '' : url.slice(at)
}

import { describe, expect, it } from 'vitest'

import { selectEncoding } from './negotiate.js'

// RFC 9110 §12.5.3 over a file with both variants, `br` the smaller.
describe('selectEncoding', () => {
  it.each([
    [undefined, 'identity'],
    ['', 'identity'],
    ['gzip, deflate, br', 'br'],
    ['gzip', 'gzip'],
    ['br;q=0.8, gzip', 'gzip'],
    ['BR', 'br'],
    ['br ; q=0.5 , gzip ; q=0.5', 'br'],
    ['x-gzip', 'gzip'],
    ['deflate', 'identity'],
    ['gzip;q=0', 'identity'],
    ['*', 'br'],
    ['*;q=0', undefined],
    ['*;q=0, identity', 'identity'],
    ['identity;q=0', undefined],
    ['identity;q=0, gzip', 'gzip'],
    ['identity, br;q=0.9', 'identity'],
    ['br;q=abc, gzip', 'gzip'],
    ['br;q=0, br', 'identity'],
    // A parameter that is not `q` neither rates nor refuses the coding it follows.
    ['br;level=5, gzip;q=0.5', 'br'],
    ['br;fast;q=0, gzip', 'gzip'],
  ])('answers %j with %s', (header, selected) => {
    expect(selectEncoding(header, ['br', 'gzip'])).toBe(selected)
  })

  // A file with no variant still answers identity, and still refuses a client that excludes it.
  it.each([
    ['gzip, deflate, br', 'identity'],
    ['*', 'identity'],
    ['*;q=0', undefined],
    ['identity;q=0', undefined],
  ])('answers %j for a file with no variant with %s', (header, selected) => {
    expect(selectEncoding(header, [])).toBe(selected)
  })

  // Parsing stays linear. A header past 32 entries is not read at all, and is refused: an entry left unread could
  // refuse the coding the rest would pick, identity included, so no representation is known to be acceptable.
  it('reads up to 32 entries, and refuses a longer header', () => {
    const filler = Array.from({ length: 31 }, (_, i) => `x-${i}`)

    expect(selectEncoding([...filler, 'br'].join(', '), ['br', 'gzip'])).toBe('br')
    expect(selectEncoding([...filler.slice(1), 'identity;q=0', 'br'].join(', '), ['br', 'gzip'])).toBe('br')
    expect(selectEncoding(['identity;q=0', ...filler, 'br'].join(', '), ['br', 'gzip'])).toBe(undefined)
    expect(selectEncoding(['*;q=0', ...filler, 'br'].join(', '), [])).toBe(undefined)
    expect(selectEncoding([...filler, 'deflate', 'br'].join(', '), ['br', 'gzip'])).toBe(undefined)
  })
})

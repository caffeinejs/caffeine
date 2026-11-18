import { describe, expect, it } from 'vitest'

import { isCompressible, selectEncoding } from './negotiate.js'

// RFC 9110 §12.5.3 over two codings offered, `br` preferred.
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

  // With no coding offered it still answers identity, and still refuses a client that excludes it.
  it.each([
    ['gzip, deflate, br', 'identity'],
    ['*', 'identity'],
    ['*;q=0', undefined],
    ['identity;q=0', undefined],
  ])('answers %j with no coding offered with %s', (header, selected) => {
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

describe('selectEncoding over codings in the order the server prefers them', () => {
  it('keeps the coding offered first among equal ratings', () => {
    expect(selectEncoding('gzip;q=1, br;q=1', ['zstd', 'br', 'gzip'])).toBe('br')
    expect(selectEncoding('*', ['zstd', 'br', 'gzip', 'deflate'])).toBe('zstd')
  })
})

describe('selectEncoding over codings the caller spells its own way', () => {
  it('matches an offered token whatever its case or alias, and answers with the entry as offered', () => {
    expect(selectEncoding('gzip', ['GZIP'])).toBe('GZIP')
    expect(selectEncoding('gzip', ['x-gzip'])).toBe('x-gzip')
    expect(selectEncoding('x-gzip', ['Gzip'])).toBe('Gzip')
    expect(selectEncoding('br;q=0, gzip', ['BR', 'Gzip'])).toBe('Gzip')
  })
})

describe('isCompressible', () => {
  it.each([
    'text/html; charset=utf-8',
    'text/plain',
    'application/json',
    'application/json; charset=utf-8',
    'application/problem+json',
    'image/svg+xml',
    'application/javascript',
    'application/xml',
  ])('compresses %s', type => {
    expect(isCompressible(type)).toBe(true)
  })

  it.each([
    'text/event-stream',
    'TEXT/EVENT-STREAM; charset=utf-8',
    'application/octet-stream',
    'image/png',
    'video/mp4',
  ])('leaves %s alone', type => {
    expect(isCompressible(type)).toBe(false)
  })
})

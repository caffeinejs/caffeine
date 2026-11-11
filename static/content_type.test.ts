import { describe, expect, it } from 'vitest'

import { contentTypeOf } from './content_type.js'

describe('contentTypeOf', () => {
  // A build on a case-insensitive file system can emit either spelling; both are the same script.
  it('reads an extension without regard to case', () => {
    expect(contentTypeOf('assets/APP.JS')).toEqual({ type: 'text/javascript; charset=utf-8', compressible: true })
  })

  it('writes a charset on a text type and on no other', () => {
    expect(contentTypeOf('index.html')?.type).toBe('text/html; charset=utf-8')
    expect(contentTypeOf('data.json')?.type).toBe('application/json')
    expect(contentTypeOf('logo.png')?.type).toBe('image/png')
  })

  // Compressing a format that is already compressed spends a second file and a second ETag on nothing.
  it('marks text and SVG compressible, and fonts and images already compressed not', () => {
    expect(contentTypeOf('icon.svg')?.compressible).toBe(true)
    expect(contentTypeOf('font.woff2')?.compressible).toBe(false)
    expect(contentTypeOf('photo.webp')?.compressible).toBe(false)
  })

  it('takes a type given for the path over one given for its extension, and either over the table', () => {
    const types = { '.js': 'application/x-other', 'sw.js': 'text/javascript' }

    expect(contentTypeOf('sw.js', types)).toEqual({ type: 'text/javascript; charset=utf-8', compressible: true })
    expect(contentTypeOf('app.js', types)).toEqual({ type: 'application/x-other', compressible: false })
  })

  it('keeps the charset a given text type names, and reads a structured type as compressible', () => {
    expect(contentTypeOf('legacy.txt', { 'legacy.txt': 'text/plain; charset=iso-8859-1' })?.type).toBe(
      'text/plain; charset=iso-8859-1',
    )
    expect(contentTypeOf('feed.xyz', { '.xyz': 'application/vnd.feed+json' })?.compressible).toBe(true)
  })

  // Served as `application/octet-stream`, a browser would sniff it: the build refuses it instead.
  it('types neither a file with no extension nor an extension it does not know', () => {
    expect(contentTypeOf('LICENSE')).toBe(undefined)
    expect(contentTypeOf('data.xyz')).toBe(undefined)
    expect(contentTypeOf('LICENSE', { LICENSE: 'text/plain' })?.type).toBe('text/plain; charset=utf-8')
  })
})

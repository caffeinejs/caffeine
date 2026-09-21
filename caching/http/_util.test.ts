import type { AdapterRequest } from '@caffeinejs/http'
import { describe, expect, it } from 'vitest'

import { generateETag, isNotModified, matchesETag, parseRequestCacheControl, pragmaNoCache } from './_util.js'

const request = (headers: Record<string, string>): AdapterRequest => ({ headers }) as unknown as AdapterRequest

describe('parseRequestCacheControl', () => {
  it('reads nothing from an absent header, and hands back one shared object for it', () => {
    expect(parseRequestCacheControl(undefined)).toBe(parseRequestCacheControl(undefined))
    expect(parseRequestCacheControl(undefined)).toEqual({
      noCache: false,
      noStore: false,
      onlyIfCached: false,
      maxAge: undefined,
    })
  })

  // RFC 9111 §5.2: directive names are case-insensitive. A client that writes `No-Cache` means it.
  it('reads directive names whatever their case', () => {
    const parsed = parseRequestCacheControl('No-Cache, NO-STORE, Only-If-Cached, MAX-AGE=5')

    expect(parsed).toEqual({ noCache: true, noStore: true, onlyIfCached: true, maxAge: 5 })
  })

  it('reads a quoted max-age, and tolerates spaces around the list', () => {
    expect(parseRequestCacheControl(' max-age="30" , no-cache ').maxAge).toBe(30)
    expect(parseRequestCacheControl('max-age=0').maxAge).toBe(0)
  })

  it('reads a max-age that is not a number as absent', () => {
    expect(parseRequestCacheControl('max-age=soon').maxAge).toBeUndefined()
    expect(parseRequestCacheControl('max-age=-1').maxAge).toBeUndefined()
  })

  it('matches a directive by its whole name, not by a substring', () => {
    const parsed = parseRequestCacheControl('x-no-cache-hint, no-store-ish=1, min-fresh=no-cache')

    expect(parsed.noCache).toBe(false)
    expect(parsed.noStore).toBe(false)
  })
})

describe('pragmaNoCache', () => {
  it('stands in for no-cache on a request without Cache-Control', () => {
    expect(pragmaNoCache(request({ pragma: 'No-Cache' }))).toBe(true)
  })

  // RFC 9111 §5.4: Cache-Control, when present, is the whole answer.
  it('is ignored next to a Cache-Control header', () => {
    expect(pragmaNoCache(request({ pragma: 'no-cache', 'cache-control': 'max-age=60' }))).toBe(false)
  })
})

describe('matchesETag', () => {
  it('compares weakly, in both directions', () => {
    expect(matchesETag('W/"abc"', '"abc"')).toBe(true)
    expect(matchesETag('"abc"', 'W/"abc"')).toBe(true)
    expect(matchesETag('"abd"', '"abc"')).toBe(false)
  })

  it('finds the tag in a list, and matches anything for *', () => {
    expect(matchesETag('"x", W/"abc" ,"y"', '"abc"')).toBe(true)
    expect(matchesETag('*', '"abc"')).toBe(true)
  })

  // An entity-tag may hold a comma, so a list cannot be cut on commas.
  it('matches an entity-tag that contains a comma', () => {
    expect(matchesETag('"x", "a,b"', '"a,b"')).toBe(true)
    expect(matchesETag('"a,b"', '"a"')).toBe(false)
  })
})

describe('isNotModified', () => {
  const lastModified = 'Mon, 01 Jan 2024 00:00:00 GMT'

  it('lets If-None-Match decide alone when it is present', () => {
    const headers = { 'if-none-match': '"other"', 'if-modified-since': 'Tue, 02 Jan 2024 00:00:00 GMT' }

    expect(isNotModified(request(headers), '"abc"', lastModified)).toBe(false)
  })

  it('falls back to If-Modified-Since without it', () => {
    expect(isNotModified(request({ 'if-modified-since': lastModified }), '"abc"', lastModified)).toBe(true)
    expect(
      isNotModified(request({ 'if-modified-since': 'Sun, 31 Dec 2023 00:00:00 GMT' }), '"abc"', lastModified),
    ).toBe(false)
  })

  it('ignores a date it cannot read, and a validator it was not given', () => {
    expect(isNotModified(request({ 'if-modified-since': 'yesterday' }), undefined, lastModified)).toBe(false)
    expect(isNotModified(request({ 'if-modified-since': lastModified }), undefined, undefined)).toBe(false)
    expect(isNotModified(request({ 'if-none-match': '"abc"' }), undefined, lastModified)).toBe(false)
  })
})

describe('generateETag', () => {
  // The tag is what clients already hold: changing how it is computed must not change what it is.
  it('hashes a payload to the strong tag it always had', async () => {
    expect(await generateETag('abc')).toBe('"a9993e364706816a"')
    expect(await generateETag(Buffer.from('abc'))).toBe('"a9993e364706816a"')
  })

  it('hands the bytes to a custom generator and uses what it returns', async () => {
    expect(await generateETag('abc', buf => `W/"${buf.length}"`)).toBe('W/"3"')
  })
})

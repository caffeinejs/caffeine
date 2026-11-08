import { afterEach, describe, expect, it, vi } from 'vitest'

import { httpDate, notModified, preconditionFailed, rangeHolds } from './conditional.js'

const STRONG = '"v1"'
const WEAK = 'W/"v1"'
const CHANGED = new Date(Date.UTC(2026, 0, 15, 10, 0, 0, 500))
const BEFORE = 'Thu, 15 Jan 2026 09:59:59 GMT'
const SAME_SECOND = 'Thu, 15 Jan 2026 10:00:00 GMT'
const AFTER = 'Thu, 15 Jan 2026 10:00:01 GMT'

describe('httpDate reads the three forms of an HTTP-date (RFC 9110 §5.6.7)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads an IMF-fixdate, the form every server sends', () => {
    expect(httpDate('Sun, 06 Nov 1994 08:49:37 GMT')).toBe(Date.UTC(1994, 10, 6, 8, 49, 37))
  })

  it('reads the obsolete RFC 850 form', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.UTC(2026, 0, 1) })

    expect(httpDate('Sunday, 06-Nov-26 08:49:37 GMT')).toBe(Date.UTC(2026, 10, 6, 8, 49, 37))
  })

  // A two-digit year more than 50 years ahead of the year the date is read in is taken from the century before, so
  // a date a client wrote in 1994 is not read as one in 2094.
  it('reads a two-digit year more than 50 years ahead as the most recent past year with those digits', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.UTC(2026, 0, 1) })

    expect(httpDate('Sunday, 06-Nov-94 08:49:37 GMT')).toBe(Date.UTC(1994, 10, 6, 8, 49, 37))
    expect(httpDate('Sunday, 06-Nov-76 08:49:37 GMT')).toBe(Date.UTC(2076, 10, 6, 8, 49, 37))
  })

  it('reads the asctime form, whose single-digit day is padded with a space', () => {
    expect(httpDate('Sun Nov  6 08:49:37 1994')).toBe(Date.UTC(1994, 10, 6, 8, 49, 37))
    expect(httpDate('Sun Nov 16 08:49:37 1994')).toBe(Date.UTC(1994, 10, 16, 8, 49, 37))
  })

  // `Date.parse` takes each of these for a date; a field carrying one that is no HTTP-date is ignored instead.
  it('reads nothing from a value in no form', () => {
    for (const value of ['2026', '12/31', '1994-11-06T08:49:37Z', 'Sun, 06 Nov 1994 08:49:37 UTC', '']) {
      expect(httpDate(value), value).toBe(undefined)
    }
  })

  it('reads nothing from a day the month does not have, or a time past the day', () => {
    expect(httpDate('Mon, 30 Feb 2026 10:00:00 GMT')).toBe(undefined)
    expect(httpDate('Mon, 02 Feb 2026 24:00:00 GMT')).toBe(undefined)
    expect(httpDate('Mon, 02 Feb 2026 10:60:00 GMT')).toBe(undefined)
    expect(httpDate('Mon, 02 Feb 2026 10:00:60 GMT')).toBe(undefined)
  })
})

describe('preconditionFailed refuses a client whose If-Match or If-Unmodified-Since no longer holds', () => {
  it('holds for If-Match: *, whatever the content', () => {
    expect(preconditionFailed(' * ', undefined, {})).toBe(false)
  })

  it('holds when a listed tag matches strongly, a comma inside a tag splitting nothing', () => {
    expect(preconditionFailed('"a,b", "v1"', undefined, { etag: STRONG })).toBe(false)
    expect(preconditionFailed('"a,b"', undefined, { etag: '"a,b"' })).toBe(false)
  })

  // A weak tag promises equivalent content, not the same bytes, which is what If-Match asks for.
  it('fails when the match is weak on either side', () => {
    expect(preconditionFailed(WEAK, undefined, { etag: STRONG })).toBe(true)
    expect(preconditionFailed(WEAK, undefined, { etag: WEAK })).toBe(true)
    expect(preconditionFailed(STRONG, undefined, { etag: WEAK })).toBe(true)
  })

  it('fails when no listed tag matches, the list holds no tag, or the content has none', () => {
    expect(preconditionFailed('"v2"', undefined, { etag: STRONG })).toBe(true)
    expect(preconditionFailed('v1', undefined, { etag: STRONG })).toBe(true)
    expect(preconditionFailed(STRONG, undefined, {})).toBe(true)
  })

  it('decides by If-Match alone when it is sent, ignoring If-Unmodified-Since', () => {
    expect(preconditionFailed(STRONG, BEFORE, { etag: STRONG, lastModified: CHANGED })).toBe(false)
    expect(preconditionFailed('"v2"', AFTER, { etag: STRONG, lastModified: CHANGED })).toBe(true)
  })

  it('fails when the content changed after the If-Unmodified-Since date, compared to the second', () => {
    expect(preconditionFailed(undefined, BEFORE, { lastModified: CHANGED })).toBe(true)
    expect(preconditionFailed(undefined, SAME_SECOND, { lastModified: CHANGED })).toBe(false)
    expect(preconditionFailed(undefined, AFTER, { lastModified: CHANGED })).toBe(false)
  })

  it('holds without either header, for a date in no form, and for content with no Last-Modified', () => {
    expect(preconditionFailed(undefined, undefined, { etag: STRONG, lastModified: CHANGED })).toBe(false)
    expect(preconditionFailed(undefined, '2020', { lastModified: CHANGED })).toBe(false)
    expect(preconditionFailed(undefined, BEFORE, {})).toBe(false)
  })
})

describe('notModified answers a client that holds the content already', () => {
  it('matches If-None-Match: * against any content', () => {
    expect(notModified('*', undefined, {})).toBe(true)
  })

  // A cache revalidating holds a representation it may have stored under either tag.
  it('matches a listed tag weakly, so a weak tag on either side still matches', () => {
    expect(notModified(`"v0", ${WEAK}`, undefined, { etag: STRONG })).toBe(true)
    expect(notModified(STRONG, undefined, { etag: WEAK })).toBe(true)
    expect(notModified(WEAK, undefined, { etag: WEAK })).toBe(true)
  })

  it('does not match another tag, a list holding no tag, or content with no tag', () => {
    expect(notModified('"v2"', undefined, { etag: STRONG })).toBe(false)
    expect(notModified('v1', undefined, { etag: STRONG })).toBe(false)
    expect(notModified(STRONG, undefined, {})).toBe(false)
  })

  it('decides by If-None-Match alone when it is sent, ignoring If-Modified-Since', () => {
    expect(notModified('"v2"', AFTER, { etag: STRONG, lastModified: CHANGED })).toBe(false)
    expect(notModified(STRONG, BEFORE, { etag: STRONG, lastModified: CHANGED })).toBe(true)
  })

  it('matches when the content has not changed since the If-Modified-Since date, compared to the second', () => {
    expect(notModified(undefined, SAME_SECOND, { lastModified: CHANGED })).toBe(true)
    expect(notModified(undefined, AFTER, { lastModified: CHANGED })).toBe(true)
    expect(notModified(undefined, BEFORE, { lastModified: CHANGED })).toBe(false)
  })

  it('does not match without either header, for a date in no form, or for content with no Last-Modified', () => {
    expect(notModified(undefined, undefined, { etag: STRONG, lastModified: CHANGED })).toBe(false)
    expect(notModified(undefined, 'yesterday', { lastModified: CHANGED })).toBe(false)
    expect(notModified(undefined, AFTER, {})).toBe(false)
  })
})

describe('rangeHolds resumes only the content the client holds part of (RFC 9110 §13.1.5)', () => {
  it('holds without If-Range', () => {
    expect(rangeHolds(undefined, {})).toBe(true)
  })

  it('holds for the strong tag of the content, and for no other tag', () => {
    expect(rangeHolds(STRONG, { etag: STRONG })).toBe(true)
    expect(rangeHolds('"v2"', { etag: STRONG })).toBe(false)
    expect(rangeHolds(STRONG, {})).toBe(false)
  })

  // Resuming joins bytes from two responses, which only the same bytes make whole.
  it('never holds for a weak tag on either side', () => {
    expect(rangeHolds(WEAK, { etag: WEAK })).toBe(false)
    expect(rangeHolds(WEAK, { etag: STRONG })).toBe(false)
    expect(rangeHolds(STRONG, { etag: STRONG.replace('"', 'W/"') })).toBe(false)
  })

  it('holds for a date on the very second of Last-Modified, and for no other', () => {
    expect(rangeHolds(SAME_SECOND, { lastModified: CHANGED })).toBe(true)
    expect(rangeHolds(AFTER, { lastModified: CHANGED })).toBe(false)
    expect(rangeHolds(BEFORE, { lastModified: CHANGED })).toBe(false)
  })

  it('does not hold for a date in no form, or for content with no Last-Modified', () => {
    expect(rangeHolds('2026', { lastModified: CHANGED })).toBe(false)
    expect(rangeHolds(SAME_SECOND, { etag: STRONG })).toBe(false)
  })
})

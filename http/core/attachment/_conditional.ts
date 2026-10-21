import type { AttachmentOptions } from './attachment.js'

type Validators = Pick<AttachmentOptions, 'etag' | 'lastModified'>

// RFC 9110 §8.8.3: one entity tag of a list. Its quoted part holds no quote, so a comma inside one does not split it.
const LISTED_TAG = /(?:W\/)?"[^"]*"/g

// RFC 9110 §5.6.7: the three forms of an HTTP-date, each in GMT and case-sensitive. IMF-fixdate is the one sent; a
// recipient reads the obsolete rfc850-date and asctime-date too.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTH = `(${MONTHS.join('|')})`
const TIME = String.raw`(\d{2}):(\d{2}):(\d{2})`
const IMF_FIXDATE = new RegExp(String.raw`^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) ${MONTH} (\d{4}) ${TIME} GMT$`)
const RFC850_DATE = new RegExp(
  String.raw`^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-${MONTH}-(\d{2}) ${TIME} GMT$`,
)
const ASCTIME_DATE = new RegExp(String.raw`^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) ${MONTH} ( \d|\d{2}) ${TIME} (\d{4})$`)

// Whether the client's precondition fails for the current content, by RFC 9110 §13.2.2: `If-Match` decides alone when
// it is sent, `*` holding and a listed tag holding only by strong comparison, so a weak tag on either side never does;
// otherwise `If-Unmodified-Since` fails when the content changed after its date. A value that is not an HTTP-date, or
// content with no Last-Modified, leaves it holding.
export function preconditionFailed(
  ifMatch: string | undefined,
  ifUnmodifiedSince: string | undefined,
  { etag, lastModified }: Validators,
): boolean {
  if (ifMatch !== undefined) {
    return ifMatch.trim() !== '*' && ifMatch.match(LISTED_TAG)?.some(tag => strongMatch(tag, etag)) !== true
  }

  const date = ifUnmodifiedSince === undefined ? undefined : httpDate(ifUnmodifiedSince)

  return date !== undefined && lastModified !== undefined && toSecond(lastModified) > date
}

// Whether the client holds the current content already, by RFC 9110 §13.2.2: `If-None-Match` decides alone when it
// is sent, comparing tags weakly; otherwise `If-Modified-Since`, to the second, when the content has a Last-Modified
// and the value is an HTTP-date.
export function notModified(
  ifNoneMatch: string | undefined,
  ifModifiedSince: string | undefined,
  { etag, lastModified }: Validators,
): boolean {
  if (ifNoneMatch !== undefined) {
    return ifNoneMatch.trim() === '*' || ifNoneMatch.match(LISTED_TAG)?.some(tag => weakMatch(tag, etag)) === true
  }

  const date = ifModifiedSince === undefined ? undefined : httpDate(ifModifiedSince)

  return date !== undefined && lastModified !== undefined && toSecond(lastModified) <= date
}

// Whether the content is still the one the client holds part of, by RFC 9110 §13.1.5: an entity tag compared
// strongly, so a weak one never holds, or the very second of Last-Modified. No If-Range at all holds.
export function rangeHolds(ifRange: string | undefined, { etag, lastModified }: Validators): boolean {
  if (ifRange === undefined) {
    return true
  }

  if (ifRange.startsWith('"') || ifRange.startsWith('W/')) {
    return strongMatch(ifRange, etag)
  }

  const date = httpDate(ifRange)

  return date !== undefined && lastModified !== undefined && toSecond(lastModified) === date
}

// RFC 9110 §8.8.3.2: both tags strong, and the same.
function strongMatch(tag: string, etag: string | undefined): boolean {
  return etag !== undefined && !etag.startsWith('W/') && tag === etag
}

// RFC 9110 §8.8.3.2: the same opaque tag, whatever either says of its strength.
function weakMatch(tag: string, etag: string | undefined): boolean {
  return etag !== undefined && withoutWeak(tag) === withoutWeak(etag)
}

function withoutWeak(tag: string): string {
  return tag.startsWith('W/') ? tag.slice(2) : tag
}

// A time as an HTTP-date carries it: to the second.
function toSecond(date: Date): number {
  return Math.floor(date.getTime() / 1000) * 1000
}

// The time an HTTP-date names, or `undefined` for a value that is not one, which every field carrying a date has its
// recipient ignore: `Date.parse` would read `2026` or `12/31` as dates.
function httpDate(value: string): number | undefined {
  const fields = dateFields(value)
  if (fields === undefined) {
    return undefined
  }

  const [day, , year, hour, minute, second] = fields.map(Number)
  const month = MONTHS.indexOf(fields[1])
  const time = Date.UTC(year, month, day, hour, minute, second)
  const date = new Date(time)

  // A day the month does not have, or a time past the day's, names no time at all.
  const named =
    date.getUTCDate() === day &&
    date.getUTCMonth() === month &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second

  return named ? time : undefined
}

// Day, month, year, hour, minute and second, in whichever of the three forms `value` is written.
function dateFields(value: string): string[] | undefined {
  const imf = IMF_FIXDATE.exec(value)
  if (imf !== null) {
    return [imf[1], imf[2], imf[3], imf[4], imf[5], imf[6]]
  }

  const rfc850 = RFC850_DATE.exec(value)
  if (rfc850 !== null) {
    return [rfc850[1], rfc850[2], String(fullYear(Number(rfc850[3]))), rfc850[4], rfc850[5], rfc850[6]]
  }

  const asctime = ASCTIME_DATE.exec(value)

  return asctime === null ? undefined : [asctime[2], asctime[1], asctime[6], asctime[3], asctime[4], asctime[5]]
}

// RFC 9110 §5.6.7: a two-digit year more than 50 years ahead is the most recent past year with those digits.
function fullYear(twoDigits: number): number {
  const thisYear = new Date().getUTCFullYear()
  const year = thisYear - (thisYear % 100) + twoDigits

  return year > thisYear + 50 ? year - 100 : year
}

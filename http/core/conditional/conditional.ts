/**
 * What a representation is validated by: its entity tag and when it last changed, as `ETag` and `Last-Modified` carry
 * them. Either may be absent; each check says what an absent one means.
 */
export interface Validators {
  /** The entity tag, quoted, weak with a `W/` prefix: `'"v42"'`, `'W/"v42"'`. */
  etag?: string
  /** When the representation last changed, compared to the second. */
  lastModified?: Date
  /**
   * Whether `lastModified` is a strong validator (RFC 9110 §8.8.2.2): the content cannot change twice within the
   * second it names, so the same date means the same bytes. Only `If-Range` asks, since resuming joins bytes from two
   * responses; without it, a date in `If-Range` never holds. A file's modification time is not strong: a file can be
   * written twice in one second.
   */
  lastModifiedStrong?: boolean
}

// RFC 9110 §8.8.3: an entity tag. Its quoted part holds no quote or space, so a comma inside one does not split it.
const ENTITY_TAG = String.raw`(?:W\/)?"[\x21\x23-\x7e\x80-\xff]*"`
const LISTED_TAG = new RegExp(ENTITY_TAG, 'g')
// RFC 9110 §5.6.1: a list of entity tags, with whitespace around its commas and empty elements. Each element owns the
// whitespace after it, so no run of whitespace can be split two ways and a malformed value fails in linear time.
const TAG_LIST = new RegExp(String.raw`^[ \t]*(?:${ENTITY_TAG}[ \t]*)?(?:,[ \t]*(?:${ENTITY_TAG}[ \t]*)?)*$`)

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

/**
 * Whether the client's precondition fails for the current content, by RFC 9110 §13.2.2.
 *
 * `If-Match` decides alone when it is sent: `*` holds, and a listed tag holds only by strong comparison, so a weak tag
 * on either side never does, nor does any tag of a value that is not a list of entity tags. Otherwise
 * `If-Unmodified-Since` fails when the content changed after its date. A value that is not an HTTP-date, or content
 * with no `Last-Modified`, leaves it holding.
 */
export function preconditionFailed(
  ifMatch: string | undefined,
  ifUnmodifiedSince: string | undefined,
  { etag, lastModified }: Validators,
): boolean {
  if (ifMatch !== undefined) {
    return ifMatch.trim() !== '*' && !listedTags(ifMatch).some(tag => strongMatch(tag, etag))
  }

  const date = ifUnmodifiedSince === undefined ? undefined : httpDate(ifUnmodifiedSince)

  return date !== undefined && lastModified !== undefined && toSecond(lastModified) > date
}

/**
 * Whether the client holds the current content already, by RFC 9110 §13.2.2.
 *
 * `If-None-Match` decides alone when it is sent, comparing tags weakly, `*` matching any; a value that is not a list of
 * entity tags matches nothing. Otherwise `If-Modified-Since`, to the second, when the content has a `Last-Modified`
 * and the value is an HTTP-date.
 */
export function notModified(
  ifNoneMatch: string | undefined,
  ifModifiedSince: string | undefined,
  { etag, lastModified }: Validators,
): boolean {
  if (ifNoneMatch !== undefined) {
    return ifNoneMatch.trim() === '*' || listedTags(ifNoneMatch).some(tag => weakMatch(tag, etag))
  }

  const date = ifModifiedSince === undefined ? undefined : httpDate(ifModifiedSince)

  return date !== undefined && lastModified !== undefined && toSecond(lastModified) <= date
}

/**
 * Whether the content is still the one the client holds part of, by RFC 9110 §13.1.5.
 *
 * An entity tag is compared strongly, so a weak one never holds. A date holds on the very second of `lastModified`,
 * and only when `lastModifiedStrong` says that second pins the bytes. No `If-Range` at all holds.
 */
export function rangeHolds(
  ifRange: string | undefined,
  { etag, lastModified, lastModifiedStrong }: Validators,
): boolean {
  if (ifRange === undefined) {
    return true
  }

  if (ifRange.startsWith('"') || ifRange.startsWith('W/')) {
    return strongMatch(ifRange, etag)
  }

  const date = httpDate(ifRange)

  return (
    lastModifiedStrong === true && date !== undefined && lastModified !== undefined && toSecond(lastModified) === date
  )
}

// The tags a list of entity tags names, or none when the value is not one: a tag written inside junk is not listed.
function listedTags(value: string): string[] {
  return TAG_LIST.test(value) ? (value.match(LISTED_TAG) ?? []) : []
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

/**
 * The time an HTTP-date names, in milliseconds since the epoch, or `undefined` for a value that is not one.
 *
 * It reads the three forms RFC 9110 §5.6.7 names: IMF-fixdate, the obsolete RFC 850 form and asctime. An RFC 850
 * date whose two-digit year puts it more than 50 years ahead of now is taken from the century before. A value in no
 * form names no time, where `Date.parse` would read `2026` or `12/31` as dates.
 */
export function httpDate(value: string): number | undefined {
  const fields = dateFields(value)
  if (fields === undefined) {
    return undefined
  }

  const [day, , year, hour, minute, second] = fields.map(Number)
  const month = MONTHS.indexOf(fields[1])
  const time =
    fields[2].length === 2
      ? rfc850Time(year, month, day, hour, minute, second)
      : Date.UTC(year, month, day, hour, minute, second)
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

// Day, month, year, hour, minute and second, in whichever of the three forms `value` is written. The year is as
// written: two digits in the RFC 850 form alone.
function dateFields(value: string): string[] | undefined {
  const imf = IMF_FIXDATE.exec(value)
  if (imf !== null) {
    return [imf[1], imf[2], imf[3], imf[4], imf[5], imf[6]]
  }

  const rfc850 = RFC850_DATE.exec(value)
  if (rfc850 !== null) {
    return [rfc850[1], rfc850[2], rfc850[3], rfc850[4], rfc850[5], rfc850[6]]
  }

  const asctime = ASCTIME_DATE.exec(value)

  return asctime === null ? undefined : [asctime[2], asctime[1], asctime[6], asctime[3], asctime[4], asctime[5]]
}

// RFC 9110 §5.6.7: a two-digit year is read in this century, unless that puts the whole date more than 50 years
// ahead, when it is the most recent past year with those digits.
function rfc850Time(
  twoDigits: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number {
  const now = new Date()
  const year = now.getUTCFullYear() - (now.getUTCFullYear() % 100) + twoDigits
  const time = Date.UTC(year, month, day, hour, minute, second)
  const cutoff = new Date(now)
  cutoff.setUTCFullYear(now.getUTCFullYear() + 50)

  return time > cutoff.getTime() ? Date.UTC(year - 100, month, day, hour, minute, second) : time
}

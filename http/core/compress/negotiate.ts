/**
 * The most `Accept-Encoding` entries read. A longer header is not read at all: `selectEncoding` answers `undefined`
 * and `acceptsEncoding` `false`, since an entry past the limit could refuse the coding the others pick, identity
 * included.
 */
const MOST_ENTRIES = 32

// RFC 9110 §12.4.2: a qvalue is 0 to 1 with at most three decimals.
const QVALUE = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/

/**
 * The content coding to send for an `Accept-Encoding` header, by RFC 9110 §12.5.3, or `undefined` when the client
 * accepts none of them, identity included.
 *
 * `available` holds the codings offered, in the order the server prefers them. Tokens compare without regard to case
 * and `x-gzip` is `gzip`. An entry whose `q` is no qvalue is ignored, the first entry for a token wins, and `q=0`
 * excludes. `*` rates every coding the header does not list, identity included. Identity, unless the header rates it,
 * is acceptable and preferred least. No header, or an empty one, gets identity: a client that sends nothing may not
 * decode. A header of more than 32 entries is not read, and gets `undefined`. Among the codings rated highest the one
 * offered first wins.
 */
export function selectEncoding<E extends string>(
  header: string | undefined,
  available: readonly E[],
): E | 'identity' | undefined {
  if (header === undefined || header.trim() === '') {
    return 'identity'
  }

  const rated = ratingsOf(header)

  if (rated === undefined) {
    return undefined
  }
  const star = rated.get('*')
  let best: E | undefined
  let bestQ = 0

  // In preference order, and only a higher rating replaces it, so a tie keeps the one offered first.
  for (const encoding of available) {
    const q = rated.get(normalize(encoding.toLowerCase())) ?? star ?? 0

    if (q > bestQ) {
      best = encoding
      bestQ = q
    }
  }

  const identity = rated.get('identity') ?? star

  if (identity === undefined) {
    return best ?? 'identity'
  }

  // Identity is preferred least, so it wins only by a higher rating.
  if (identity > bestQ) {
    return 'identity'
  }

  return best
}

/**
 * Whether an `Accept-Encoding` header rates `coding` above zero, by RFC 9110 §12.5.3: whether a response in that
 * coding is one the client accepts, whatever it prefers.
 *
 * Read as {@link selectEncoding} reads it: tokens compare without regard to case, `x-gzip` is `gzip`, the first entry
 * for a token wins and `*` rates every coding the header does not list. `identity` is accepted unless the header rates
 * it, or `*`, at `q=0`. No header, or an empty one, accepts identity alone, and a header of more than 32 entries
 * accepts nothing.
 */
export function acceptsEncoding(header: string | undefined, coding: string): boolean {
  const token = normalize(coding.trim().toLowerCase())

  if (header === undefined || header.trim() === '') {
    return token === 'identity'
  }

  const rated = ratingsOf(header)

  if (rated === undefined || token === '') {
    return false
  }

  return (rated.get(token) ?? rated.get('*') ?? (token === 'identity' ? 1 : 0)) > 0
}

/** The header's ratings, or `undefined` for a header of more than 32 entries, which is not read. */
function ratingsOf(header: string): Map<string, number> | undefined {
  // Split no further than one entry past the limit, so the work stays bounded however long the header.
  const entries = header.split(',', MOST_ENTRIES + 1)

  return entries.length > MOST_ENTRIES ? undefined : ratings(entries)
}

/** The rating of each token the header's entries list, the first entry for a token winning. */
function ratings(entries: readonly string[]): Map<string, number> {
  const rated = new Map<string, number>()

  for (const entry of entries) {
    const [name = '', ...params] = entry.split(';')
    const token = normalize(name.trim().toLowerCase())

    if (token === '' || rated.has(token)) {
      continue
    }

    const q = qOf(params)

    if (q !== undefined) {
      rated.set(token, q)
    }
  }

  return rated
}

/** A coding token, lower-case, as RFC 9110 §8.4.1.3 has a recipient read it: `x-gzip` is `gzip`. */
export function normalize(token: string): string {
  return token === 'x-gzip' ? 'gzip' : token
}

/** The entry's `q`, `1` when it has none, `undefined` when it is no qvalue. */
function qOf(params: readonly string[]): number | undefined {
  for (const param of params) {
    const eq = param.indexOf('=')

    if (eq !== -1 && param.slice(0, eq).trim().toLowerCase() === 'q') {
      const value = param.slice(eq + 1).trim()

      return QVALUE.test(value) ? Number(value) : undefined
    }
  }

  return 1
}

// Text the coders shrink: `text/*`, and the JSON, XML and JavaScript families. Kept apart from
// `@caffeinejs/static`'s copy, which its build reads without loading the server.
const COMPRESSIBLE = /^(?:text\/|application\/(?:json|xml|javascript)\b|[^;]*\+(?:json|xml)\b)/i
const EVENT_STREAM = /^text\/event-stream\b/i

/**
 * Whether a body of `type`, a `Content-Type` value, is worth compressing: text, JSON, XML and JavaScript.
 *
 * Never `text/event-stream`, whose events a client must get as they are sent, nor `application/octet-stream`, which is
 * as often bytes already compressed.
 */
export function isCompressible(type: string): boolean {
  return COMPRESSIBLE.test(type) && !EVENT_STREAM.test(type)
}

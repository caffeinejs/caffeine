import type { Encoding } from './manifest/manifest.js'

/**
 * The most `Accept-Encoding` entries read. A longer header is not read at all: an entry past the limit could refuse
 * the coding the others pick.
 */
const MOST_ENTRIES = 32

// RFC 9110 §12.4.2: a qvalue is 0 to 1 with at most three decimals.
const QVALUE = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/

/**
 * The representation of a file to send for an `Accept-Encoding` header, by RFC 9110 §12.5.3, or `undefined` when the
 * client accepts none of them and the answer is `406`.
 *
 * `available` holds the codings the file has a variant in, smallest first; identity is always there and always the
 * largest. Tokens compare without regard to case and `x-gzip` is `gzip`. An entry whose `q` is no qvalue is ignored,
 * the first entry for a token wins, and `q=0` excludes. `*` rates every coding the header does not list, identity
 * included. Identity, unless the header rates it, is acceptable and preferred least. No header, or an empty one, gets
 * identity: a client that sends nothing may not decode, and so does a header of more than 32 entries, which is not
 * read. Among the codings rated highest the smallest wins.
 */
export function selectEncoding(
  header: string | undefined,
  available: readonly Encoding[],
): Encoding | 'identity' | undefined {
  if (header === undefined || header.trim() === '') {
    return 'identity'
  }

  // Split no further than one entry past the limit, so the work stays bounded however long the header.
  const entries = header.split(',', MOST_ENTRIES + 1)

  if (entries.length > MOST_ENTRIES) {
    return 'identity'
  }

  const rated = ratings(entries)
  const star = rated.get('*')
  let best: Encoding | undefined
  let bestQ = 0

  // Smallest first, and only a higher rating replaces it, so a tie keeps the smaller.
  for (const encoding of available) {
    const q = rated.get(encoding) ?? star ?? 0

    if (q > bestQ) {
      best = encoding
      bestQ = q
    }
  }

  const identity = rated.get('identity') ?? star

  if (identity === undefined) {
    return best ?? 'identity'
  }

  // Identity is the largest, so it wins only by a higher rating.
  if (identity > bestQ) {
    return 'identity'
  }

  return best
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

// RFC 9110 §8.4.1.3: a recipient treats `x-gzip` as `gzip`.
function normalize(token: string): string {
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

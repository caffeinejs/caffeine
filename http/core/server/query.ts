/**
 * Parses a query string as handlers read it: a repeated key is a list, `+` is a space, an escape that does not decode
 * is kept as written. The result has no prototype, so `__proto__` is a key like any other.
 */
export function parseQuery(query: string): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = Object.create(null)
  let start = 0

  while (start <= query.length) {
    let end = query.indexOf('&', start)
    if (end === -1) {
      end = query.length
    }

    if (end > start) {
      const pair = query.slice(start, end)
      const equals = pair.indexOf('=')
      const key = decode(equals === -1 ? pair : pair.slice(0, equals))
      const value = equals === -1 ? '' : decode(pair.slice(equals + 1))
      const current = result[key]

      if (current === undefined) {
        result[key] = value
      } else if (typeof current === 'string') {
        result[key] = [current, value]
      } else {
        current.push(value)
      }
    }

    start = end + 1
  }

  return result
}

/** `+` as a space, then percent-decoding, keeping the text as written where an escape does not decode. */
function decode(text: string): string {
  const spaced = text.includes('+') ? text.replaceAll('+', ' ') : text

  if (!spaced.includes('%')) {
    return spaced
  }

  try {
    return decodeURIComponent(spaced)
  } catch {
    return spaced
  }
}

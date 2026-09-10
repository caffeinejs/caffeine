/**
 * Configuration keys are dotted paths (`server.port`). A literal dot inside a single segment is escaped as
 * `\.`, so the split and the join here are exact inverses — which matters as soon as a path is produced
 * programmatically (a feature namespace, a selector recording) rather than typed by hand.
 */

/** Splits a dotted config key into its segments, honouring `\.` escapes. */
export function splitPath(key: string): string[] {
  const parts: string[] = []
  let current = ''
  let i = 0

  while (i < key.length) {
    if (key[i] === '\\' && i + 1 < key.length && key[i + 1] === '.') {
      current += '.'
      i += 2
    } else if (key[i] === '.') {
      parts.push(current)
      current = ''
      i++
    } else {
      current += key[i]
      i++
    }
  }

  parts.push(current)
  return parts
}

/** Joins segments into a dotted config key, escaping any literal dot a segment contains. */
export function joinPath(parts: readonly string[]): string {
  return parts.map(escapeSegment).join('.')
}

/** One segment with its literal dots escaped — the per-part transform {@link joinPath} applies. */
export function escapeSegment(part: string): string {
  return part.split('.').join('\\.')
}

/** Normalizes a path given either pre-split or dotted into segments. */
export function toPathParts(path: string | readonly string[]): string[] {
  return typeof path === 'string' ? splitPath(path) : [...path]
}

/** Whether a segment is an array index: an unsigned integer with no leading zero. */
export function isIndexSegment(part: string): boolean {
  return INDEX.test(part)
}

const INDEX = /^(0|[1-9]\d*)$/

/**
 * Whether `key` is in `set`, or sits beneath something that is.
 *
 * The prefix test is what makes marking a parent enough — for a secret, so `$t.Secret` on an object hides its
 * fields; for a merge claim, so the source that owns `tags` owns `tags.0` as well.
 *
 * Each probed ancestor is re-encoded with {@link joinPath}, so a parent whose own segment holds a literal dot
 * still matches: `set` holds keys the same way `secretPaths` and `claimsOf` write them.
 */
export function hasPrefixIn(key: string, set: ReadonlySet<string>): boolean {
  if (set.size === 0) {
    return false
  }
  if (set.has(key)) {
    return true
  }

  const parts = splitPath(key)

  for (let i = 1; i < parts.length; i++) {
    if (set.has(joinPath(parts.slice(0, i)))) {
      return true
    }
  }

  return false
}

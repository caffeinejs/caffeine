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
  return parts.map(part => part.split('.').join('\\.')).join('.')
}

/** Normalizes a path given either pre-split or dotted into segments. */
export function toPathParts(path: string | readonly string[]): string[] {
  return typeof path === 'string' ? splitPath(path) : [...path]
}

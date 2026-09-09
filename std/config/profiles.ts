import { textList } from '../schema/text.js'

/**
 * Normalizes a raw active-profile value into a unique list, in first-seen order.
 *
 * Accepts what a source actually produces: a string array from a file or the code band, or delimited text
 * (`CAFFEINE__PROFILES=eu,dev`) from an environment variable or a command-line argument. Blank entries are
 * dropped, and a profile named twice keeps only its first position, so no provider ever sees a duplicate.
 */
export function activeProfiles(raw: unknown, separator?: string): string[] {
  const split = textList(raw, separator)
  const list = Array.isArray(split) ? split : []
  const seen = new Set<string>()

  for (const entry of list) {
    if (typeof entry !== 'string') {
      continue
    }
    const profile = entry.trim()
    if (profile !== '') {
      seen.add(profile)
    }
  }

  return [...seen]
}

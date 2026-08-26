/** The separator a delimited list uses when none is named. */
export const DEFAULT_LIST_SEPARATOR = ','

/**
 * Splits delimited text into its elements.
 *
 * This is what makes a list expressible in a source that only carries text — an environment variable, a
 * command-line argument — without the indexed spelling (`TAGS__0`, `TAGS__1`) that cannot be shortened by hand
 * and cannot express an empty list at all.
 *
 * Anything that is not a string is returned untouched, so the same function serves a value that already arrived
 * structured (from a file, or from the code band) and one that arrived as text.
 *
 * - Elements are trimmed, so `a, b` and `a,b` agree.
 * - An empty string is an empty list. That is the only way to clear a list from a higher-priority source.
 * - A backslash escapes the character after it, so `a\,b,c` is two elements, the first containing a comma.
 *
 * Exported rather than kept private because a Standard Schema library cannot be introspected, so zod, valibot
 * and arktype cannot get `$t.List`'s treatment automatically. They wrap this instead:
 *
 * ```ts
 * z.object({ tags: z.preprocess(textList, z.array(z.string())) })
 * ```
 */
export function textList(value: unknown, separator?: unknown): unknown {
  if (typeof value !== 'string') {
    return value
  }

  // `separator` is typed loosely on purpose. The documented zod usage passes this function itself to
  // `z.preprocess`, which calls it with `(value, ctx)` — a second argument that is not a separator at all, and
  // which would otherwise be stringified into one and split on nothing.
  const delimiter = typeof separator === 'string' && separator !== '' ? separator : DEFAULT_LIST_SEPARATOR
  const text = value.trim()
  if (text === '') {
    return []
  }

  const elements: string[] = []
  let current = ''

  // Index-based rather than character-based so a multi-character separator works as well as a single one.
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && i + 1 < text.length) {
      current += text[i + 1]
      i++
      continue
    }
    if (text.startsWith(delimiter, i)) {
      elements.push(current.trim())
      current = ''
      i += delimiter.length - 1
      continue
    }
    current += text[i]
  }

  elements.push(current.trim())

  return elements
}

/** The part of a reply {@link appendVary} touches, so a reply of any server parameterization fits. */
export interface VaryReply {
  getHeader(name: string): unknown
  header(name: string, value: string): unknown
}

/**
 * Adds `names` to the reply's `Vary` header, keeping what is already there.
 *
 * Field names compare without regard to case and the first spelling is kept. `*` covers every header: one
 * already on the reply is left alone, and one among `names` replaces the list.
 */
export function appendVary(reply: VaryReply, names: readonly string[]): void {
  const current = reply.getHeader('vary')
  const merged =
    typeof current === 'string'
      ? current
          .split(',')
          .map(token => token.trim())
          .filter(Boolean)
      : []

  if (merged.includes('*')) {
    return
  }

  if (names.includes('*')) {
    reply.header('vary', '*')
    return
  }

  const seen = new Set(merged.map(name => name.toLowerCase()))
  for (const name of names) {
    const lower = name.toLowerCase()
    if (!seen.has(lower)) {
      seen.add(lower)
      merged.push(name)
    }
  }

  reply.header('vary', merged.join(', '))
}

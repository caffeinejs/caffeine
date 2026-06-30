export function mergeValue(existing: unknown, incoming: unknown): unknown {
  if (existing === undefined) { return incoming }

  if (incoming instanceof Map && existing instanceof Map) {
    const result = new Map(existing)
    for (const [k, v] of incoming) { result.set(k, v) }
    return result
  }

  if (incoming instanceof Set && existing instanceof Set) {
    return new Set([...existing, ...incoming])
  }

  if (Array.isArray(incoming) && Array.isArray(existing)) {
    return [...existing, ...incoming]
  }

  if (
    typeof incoming === 'object' && incoming !== null && !Array.isArray(incoming)
    && typeof existing === 'object' && existing !== null && !Array.isArray(existing)
    && !(incoming instanceof Map) && !(incoming instanceof Set)
    && !(existing instanceof Map) && !(existing instanceof Set)
  ) {
    return Object.assign({}, existing, incoming)
  }

  return incoming
}

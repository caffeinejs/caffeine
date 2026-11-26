/**
 * A Map that replaces what outer levels hold under its key rather than merging with it when the levels are laid over
 * each other: route options make one where a key's `null` drops what the groups set.
 */
export class ReplacingMap<K, V> extends Map<K, V> {}

export function mergeValue(existing: unknown, incoming: unknown): unknown {
  if (existing === undefined) {
    return incoming
  }

  if (incoming instanceof ReplacingMap) {
    return incoming
  }

  if (incoming instanceof Map && existing instanceof Map) {
    const result = new Map(existing)
    for (const [k, v] of incoming) {
      result.set(k, v)
    }
    return result
  }

  if (incoming instanceof Set && existing instanceof Set) {
    return new Set([...existing, ...incoming])
  }

  if (Array.isArray(incoming) && Array.isArray(existing)) {
    return [...existing, ...incoming]
  }

  if (isPlainObject(existing) && isPlainObject(incoming)) {
    // Spread, not `Object.assign`, which would turn an own `__proto__` key into the prototype. Values below this level
    // are carried as they are.
    return { ...existing, ...incoming }
  }

  return incoming
}

/**
 * Merges each own enumerable key of `source`, a symbol included, into `target` through {@link mergeValue}. An own
 * `__proto__` key is skipped: written by assignment, it would set `target`'s prototype.
 */
export function mergeInto(target: Record<PropertyKey, unknown>, source: object): void {
  for (const key of ownKeys(source)) {
    if (key !== '__proto__') {
      target[key] = mergeValue(target[key], (source as Record<PropertyKey, unknown>)[key])
    }
  }
}

/** The own enumerable keys of `value`, its symbols included, as a spread copies them. */
export function ownKeys(value: object): PropertyKey[] {
  return Reflect.ownKeys(value).filter(key => Object.prototype.propertyIsEnumerable.call(value, key))
}

// Only these merge member by member: a class instance, such as a RegExp or a Date, would come out as a bare `{}`.
function isPlainObject(value: unknown): value is Record<PropertyKey, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

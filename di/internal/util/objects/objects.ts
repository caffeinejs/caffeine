import { isNil } from '../assert/is_nil.js'

export function mergeObject<T>(value: any, other: any): T {
  const res: Record<string | symbol, unknown> = Object.assign({}, value)

  for (const key of Reflect.ownKeys(other)) {
    if (!isNil(other[key])) {
      res[key as string | symbol] = other[key]
    }
  }

  return res as T
}

// Reads a value out of `source` with a selector, or by a dot-separated path that stops at the first null link.
export function selector(access: string | ((source: never) => unknown)): (source: unknown) => unknown {
  if (typeof access !== 'string') {
    return access as (source: unknown) => unknown
  }

  const keys = access.split('.')

  return source =>
    keys.reduce((acc: unknown, k) => (acc == null ? undefined : (acc as Record<string, unknown>)[k]), source)
}

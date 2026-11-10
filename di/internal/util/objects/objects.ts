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

/** Names what `value` is for a message, such as `an array` or `a value of type number`. */
export function typeName(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value)
  }
  if (value === '') {
    return 'an empty string'
  }
  if (Array.isArray(value)) {
    return 'an array'
  }
  if (value instanceof Promise) {
    return 'a Promise'
  }

  return `a value of type ${typeof value}`
}

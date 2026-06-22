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

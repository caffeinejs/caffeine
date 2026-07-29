import type { ConfigSnapshot } from './types.js'

export function materialize(snapshot: ConfigSnapshot): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  for (const [key, entry] of snapshot.values) {
    setByPath(result, splitKey(key), entry.value)
  }

  return result
}

function splitKey(key: string): string[] {
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

function setByPath(obj: Record<string, unknown>, parts: string[], value: unknown): void {
  let node = obj

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]
    const existing = node[part]

    if (existing === null || existing === undefined) {
      node[part] = {}
      node = node[part] as Record<string, unknown>
    } else if (typeof existing === 'object' && !Array.isArray(existing)) {
      node = existing as Record<string, unknown>
    } else {
      node[part] = {}
      node = node[part] as Record<string, unknown>
    }
  }

  node[parts[parts.length - 1]] = value
}

export function readByPath(obj: unknown, path: string): unknown {
  return splitKey(path).reduce<unknown>((acc, part) => {
    if (acc !== null && acc !== undefined && typeof acc === 'object' && part in (acc as object)) {
      return (acc as Record<string, unknown>)[part]
    }
    return undefined
  }, obj)
}

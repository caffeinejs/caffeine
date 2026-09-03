import { splitPath } from './path.js'
import type { ConfigSnapshot } from './types.js'

const INDEX_KEY = /^(0|[1-9]\d*)$/

export function materialize(snapshot: ConfigSnapshot): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  for (const [key, entry] of snapshot.values) {
    setByPath(result, splitPath(key), entry.value)
  }

  return promoteNumericObjects(result) as Record<string, unknown>
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
      // Indexed children win over a whole-array (or scalar) leaf at the same path.
      node[part] = {}
      node = node[part] as Record<string, unknown>
    }
  }

  const last = parts[parts.length - 1]
  const existing = node[last]
  // Indexed children already present — do not let a whole-array leaf overwrite them.
  if (Array.isArray(value) && existing !== null && typeof existing === 'object' && !Array.isArray(existing)) {
    return
  }
  node[last] = value
}

/**
 * Converts plain objects whose own keys are all unsigned integer strings into dense Arrays.
 * Runs depth-first so nested numeric objects (array elements that are objects containing arrays)
 * are promoted before their parents.
 */
function promoteNumericObjects(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(promoteNumericObjects)
  }

  if (value === null || typeof value !== 'object') {
    return value
  }

  const record = value as Record<string, unknown>
  const promoted: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(record)) {
    promoted[k] = promoteNumericObjects(v)
  }

  const keys = Object.keys(promoted)
  if (keys.length === 0 || !keys.every(k => INDEX_KEY.test(k))) {
    return promoted
  }

  let max = -1
  for (const k of keys) {
    const n = Number(k)
    if (n > max) {
      max = n
    }
  }

  const arr: unknown[] = new Array(max + 1)
  for (const k of keys) {
    arr[Number(k)] = promoted[k]
  }
  return arr
}

export function readByPath(obj: unknown, path: string): unknown {
  return readByParts(obj, splitPath(path))
}

/**
 * Reads a value from an already-split path. This is the form the hot paths use: a feature namespace is split
 * once when the feature is configured, so a lookup never re-scans the key.
 */
export function readByParts(obj: unknown, parts: readonly string[]): unknown {
  let acc: unknown = obj

  for (const part of parts) {
    if (acc === null || acc === undefined || typeof acc !== 'object') {
      return undefined
    }
    if (Array.isArray(acc)) {
      if (!INDEX_KEY.test(part)) {
        return undefined
      }
      acc = acc[Number(part)]
      continue
    }
    acc = part in (acc as object) ? (acc as Record<string, unknown>)[part] : undefined
  }

  return acc
}

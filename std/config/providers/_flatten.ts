import type { ConfigEntry, ConfigValue } from '../types.js'

export function flattenObject(obj: unknown, origin: string, prefix: string, out: Map<string, ConfigEntry>): void {
  if (Array.isArray(obj)) {
    if (obj.length === 0) {
      // Empty arrays must remain discoverable — indexing alone would emit zero keys.
      out.set(prefix, { key: prefix, value: [], origin })
      return
    }
    for (let i = 0; i < obj.length; i++) {
      const path = prefix ? `${prefix}.${i}` : String(i)
      flattenObject(obj[i], origin, path, out)
    }
    return
  }

  if (obj !== null && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${k}` : k
      flattenObject(v, origin, path, out)
    }
    return
  }

  out.set(prefix, { key: prefix, value: obj as ConfigValue, origin })
}

import type { ConfigEntry, ConfigValue } from '../types.js'

export function flattenObject(
  obj: unknown,
  origin: string,
  prefix: string,
  out: Map<string, ConfigEntry>,
): void {
  if (obj !== null && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${k}` : k
      flattenObject(v, origin, path, out)
    }
  } else {
    out.set(prefix, { key: prefix, value: obj as ConfigValue, origin })
  }
}

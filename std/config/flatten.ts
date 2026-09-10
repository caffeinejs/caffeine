import type { ConfigEntry, ConfigValue } from './config.js'

/**
 * Flattens a nested value into the dotted leaf keys a property source carries.
 *
 * Every provider produces entries this way, so an environment variable and an object literal are merged by the
 * same per-leaf rules and one source can override a single field without erasing its siblings.
 *
 * A key is appended raw, so a dot inside one reads as a path separator: a parser handing back the flat
 * `{ 'db.host': 'x' }` means the same thing as the nested `{ db: { host: 'x' } }`, which is what lets a format
 * with no nesting of its own — INI, a properties file, a flat environment dump — describe a whole tree. A
 * caller that means a segment literally escapes it first, the way `joinPath` does.
 *
 * @param prefix - Already a config key, appended to as is. Callers writing from the tree root pass `''`;
 *   {@link MutableConfigProvider.set} passes a key it built with `joinPath` from pre-split parts.
 */
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

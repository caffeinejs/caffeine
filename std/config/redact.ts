import { isSecretSchema } from '../schema/t.js'
import { isForbiddenKey, isPlainObject } from './tree.js'

/** What a redacted value reads as. A fixed string, so a dump keeps the shape it would otherwise have. */
export const REDACTED = '[redacted]'

/** Where secrets live, as split paths. `*` stands for any array index or record key. */
export type SecretPaths = readonly (readonly string[])[]

const ANY = '*'

/**
 * The paths a schema marked with `$t.Secret`. A marked object hides everything beneath it.
 *
 * Only the `$t` dialect can be walked. A foreign Standard Schema exposes no shape, so a secret declared in one is
 * not found.
 */
export function collectSecretPaths(schema: unknown): SecretPaths {
  const found: string[][] = []
  collect(schema, [], found, new Set())
  return found
}

/** Whether `parts` is a secret or sits beneath one. */
export function isSecretPath(parts: readonly string[], secrets: SecretPaths): boolean {
  return secrets.some(secret => secret.length <= parts.length && matches(secret, parts))
}

/**
 * `value`, found at `parts`, with every secret at or beneath it replaced by {@link REDACTED}. The original is never
 * touched, and a value holding no secret comes back as it is.
 */
export function redactValue(value: unknown, parts: readonly string[], secrets: SecretPaths): unknown {
  if (secrets.length === 0) {
    return value
  }
  if (isSecretPath(parts, secrets)) {
    return REDACTED
  }
  if (!secrets.some(secret => secret.length > parts.length && matches(secret, parts))) {
    return value
  }

  if (Array.isArray(value)) {
    return value.map((element, i) => redactValue(element, [...parts, String(i)], secrets))
  }

  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value)) {
      if (!isForbiddenKey(key)) {
        out[key] = redactValue(value[key], [...parts, key], secrets)
      }
    }
    return out
  }

  return value
}

/** Whether the first `secret.length` segments of `parts`, or all of them if fewer, match `secret`. */
function matches(secret: readonly string[], parts: readonly string[]): boolean {
  const length = Math.min(secret.length, parts.length)
  for (let i = 0; i < length; i++) {
    if (secret[i] !== ANY && secret[i] !== parts[i]) {
      return false
    }
  }
  return true
}

function collect(node: unknown, path: readonly string[], out: string[][], seen: Set<object>): void {
  if (typeof node !== 'object' || node === null) {
    return
  }

  // A schema may be recursive, and a codec holds a reference back to what it wraps.
  if (seen.has(node)) {
    return
  }
  seen.add(node)

  if (isSecretSchema(node) && path.length > 0) {
    out.push([...path])
    return
  }

  const schema = node as Record<string, unknown>

  const properties = schema.properties
  if (typeof properties === 'object' && properties !== null) {
    for (const [key, value] of Object.entries(properties)) {
      collect(value, [...path, key], out, seen)
    }
  }

  // A union's branches sit at the same path: `$t.Optional`, `$t.Nullable` and the codecs all produce one.
  for (const key of ['anyOf', 'allOf', 'oneOf'] as const) {
    const branches = schema[key]
    if (Array.isArray(branches)) {
      for (const branch of branches) {
        collect(branch, path, out, seen)
      }
    }
  }

  // An array's items and a record's values sit at a key not known until a value exists.
  collect(schema.items, [...path, ANY], out, seen)

  const patterns = schema.patternProperties
  if (typeof patterns === 'object' && patterns !== null) {
    for (const value of Object.values(patterns)) {
      collect(value, [...path, ANY], out, seen)
    }
  }
  collect(schema.additionalProperties, [...path, ANY], out, seen)
}

import { isSecretSchema } from '../schema/t.js'
import { joinPath, splitPath } from './path.js'

/** What a redacted value reads as. A fixed string, so a dump stays the same shape it would otherwise be. */
export const REDACTED = '[redacted]'

/**
 * The dotted paths a schema marked with `$t.Secret`.
 *
 * Walked once, when the slice is registered, rather than consulted per read: the schema does not change between
 * refreshes, and a diagnostics call should not be re-traversing a schema tree to answer one question.
 *
 * Only the `$t` dialect is introspected. A foreign Standard Schema is validated by its own library and exposes
 * no shape to walk, so a secret declared in one is simply not marked — worth knowing before reaching for zod to
 * describe a slice that holds credentials.
 */
export function secretPaths(schema: unknown, prefix: readonly string[] = []): string[] {
  const found: string[] = []
  collect(schema, prefix, found, new Set())
  return found
}

function collect(node: unknown, path: readonly string[], out: string[], seen: Set<object>): void {
  if (typeof node !== 'object' || node === null) {
    return
  }

  // A schema may be recursive, and a `$t.Transform` holds a reference back to what it wraps.
  if (seen.has(node)) {
    return
  }
  seen.add(node)

  if (isSecretSchema(node) && path.length > 0) {
    out.push(joinPath(path))
    // Everything beneath a marked node is covered by the mark itself — an object marked secret hides whole.
    return
  }

  const schema = node as Record<string, unknown>

  const properties = schema.properties
  if (typeof properties === 'object' && properties !== null) {
    for (const [key, value] of Object.entries(properties)) {
      collect(value, [...path, key], out, seen)
    }
  }

  // A union's branches sit at the same path — `$t.Optional`, `$t.Nullable` and the codecs all produce one.
  for (const key of ['anyOf', 'allOf', 'oneOf'] as const) {
    const branches = schema[key]
    if (Array.isArray(branches)) {
      for (const branch of branches) {
        collect(branch, path, out, seen)
      }
    }
  }

  // An array's items share one path: the index is not known until a value exists, so `tags` covers `tags.0`.
  collect(schema.items, path, out, seen)
}

/**
 * Whether `path` is a secret, or sits beneath one.
 *
 * The prefix test is what makes marking an object enough: `$t.Secret($t.Object({...}))` at `auth.credentials`
 * has to hide `auth.credentials.password` too, or marking the parent would be a false reassurance.
 */
export function isSecretPath(secrets: ReadonlySet<string>, path: string): boolean {
  if (secrets.size === 0) {
    return false
  }
  if (secrets.has(path)) {
    return true
  }

  const parts = splitPath(path)
  let prefix = ''

  for (const part of parts) {
    prefix = prefix === '' ? part : `${prefix}.${part}`
    if (secrets.has(prefix)) {
      return true
    }
  }

  return false
}

/**
 * `value` with every secret beneath `path` replaced.
 *
 * Applied to whatever a diagnostic hands back, so a caller that asks for a subtree does not get around the
 * redaction by asking one level up. The original is never touched — a feature reads the real value through its
 * slice, which does not go through here at all.
 */
export function redact(secrets: ReadonlySet<string>, path: string, value: unknown): unknown {
  if (secrets.size === 0) {
    return value
  }
  if (isSecretPath(secrets, path)) {
    return REDACTED
  }
  if (typeof value !== 'object' || value === null) {
    return value
  }

  if (Array.isArray(value)) {
    return value.map(item => redact(secrets, path, item))
  }

  const out: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    out[key] = redact(secrets, path === '' ? key : `${path}.${key}`, nested)
  }

  return out
}

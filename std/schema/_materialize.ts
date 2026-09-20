import { type TSchema, TypeGuard } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'

/**
 * Creates the object nodes a schema declares and the input omits, so a block whose fields all carry defaults
 * materializes from nothing instead of failing as a missing required property.
 *
 * `Value.Default` walks the value rather than the schema, so an absent property has nothing to descend into and a
 * nested object is never built from its children's defaults. This walks the schema instead, and only ever adds an
 * empty node — every value in the result still comes from the input or from a declared default, so a wrong value
 * fails validation exactly as before. That is the half of `Value.Cast` worth having: it repairs structure and not
 * content.
 *
 * An absent object that declares its own `default` is seeded with a clone of it rather than with `{}`, which is
 * what `Value.Default` would have placed there — so materializing first changes nothing for those schemas, and
 * their deeper levels get filled in too.
 */
export function materializeObjects(schema: TSchema, value: unknown): unknown {
  return visit(schema, value, new Set())
}

function visit(schema: TSchema, value: unknown, seen: Set<TSchema>): unknown {
  // Only an object has a single unambiguous shape to create. A record has no declared keys, and a union, an
  // intersect or a codec has no one branch to pick.
  if (!TypeGuard.IsObject(schema) || seen.has(schema)) {
    return value
  }

  if (!isPlainObject(value)) {
    return value
  }

  // A schema may reference itself through `Type.Recursive`, so a node is walked once per path.
  seen.add(schema)

  for (const [key, property] of Object.entries(schema.properties)) {
    // An optional object stays absent: the author said optional and meant it.
    if (!TypeGuard.IsObject(property) || TypeGuard.IsOptional(property)) {
      continue
    }

    const current = value[key] === undefined ? seedFor(property) : value[key]
    const next = visit(property, current, seen)

    if (next !== undefined) {
      value[key] = next
    }
  }

  seen.delete(schema)

  return value
}

function seedFor(schema: TSchema): unknown {
  return schema.default === undefined ? {} : Value.Clone(schema.default)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

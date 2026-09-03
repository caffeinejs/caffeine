import type { JSONSchema } from '@caffeinejs/std/schema'

/** Keywords that are not scoped to a single type, and so cannot be merged onto a type array safely. */
const TYPE_AGNOSTIC = ['enum', 'const'] as const

/** Where a nested schema can appear. Covers what TypeBox and the Standard Schema converters actually emit. */
const CHILD_KEYWORDS = ['properties', 'patternProperties'] as const
const LIST_KEYWORDS = ['anyOf', 'allOf', 'oneOf'] as const

/**
 * Rewrites JSON Schema that Ajv, as Fastify configures it, would mishandle or compile poorly.
 *
 * Two collapses, both value-preserving:
 *
 * - `anyOf: [X, { type: 'null' }]` becomes `type: [<X's type>, 'null']`. With `coerceTypes: 'array'`, Ajv walks an
 *   `anyOf` and coerces the value into the first branch that will take it, so a `null` sent against
 *   `[{ type: 'string' }, { type: 'null' }]` arrives at the handler as `''`. A type array does not coerce a value
 *   that already matches one of its types.
 * - `anyOf` of `{ const, type }` branches becomes `{ type, enum }` (or a bare `{ enum }` when the types mix). Ajv
 *   compiles that to one check instead of one branch per member, OpenAPI tooling renders it, and a mismatch is a
 *   single error rather than one per branch.
 *
 * The dialect cannot emit either shape itself: TypeBox's own `Value` (which validates configuration) throws
 * `Unknown type` on a schema it did not build. So the union is what `$t` produces, and this normalizes it on the
 * way to Fastify — the same division of labour as the per-slot `additionalProperties` policy.
 *
 * The two rules are disjoint. A nullable union needs a `{ type: 'null' }` branch and a non-const other; a literal
 * union needs every branch to be exactly `const` plus `type`. `$t.Nullable($t.Literal('a'))` is refused by both and
 * stays an `anyOf`.
 */
export function normalizeForAjv(schema: JSONSchema): JSONSchema {
  const withChildren = mapChildren(schema)
  return collapseLiteralUnion(collapseNullableUnion(withChildren))
}

function mapChildren(schema: JSONSchema): JSONSchema {
  let result = schema

  for (const keyword of CHILD_KEYWORDS) {
    const record = schema[keyword]
    if (!isSchemaRecord(record)) {
      continue
    }

    let changed = false
    const mapped: Record<string, JSONSchema> = {}
    for (const [key, child] of Object.entries(record)) {
      mapped[key] = normalizeForAjv(child)
      changed ||= mapped[key] !== child
    }

    if (changed) {
      result = { ...result, [keyword]: mapped }
    }
  }

  for (const keyword of LIST_KEYWORDS) {
    const list = schema[keyword]
    if (!Array.isArray(list)) {
      continue
    }

    const mapped = list.map(child => (isSchema(child) ? normalizeForAjv(child) : child))
    if (mapped.some((child, i) => child !== list[i])) {
      result = { ...result, [keyword]: mapped }
    }
  }

  for (const keyword of ['items', 'additionalProperties', 'not'] as const) {
    const child = schema[keyword]

    if (Array.isArray(child)) {
      const mapped = child.map(item => (isSchema(item) ? normalizeForAjv(item) : item))
      if (mapped.some((item, i) => item !== child[i])) {
        result = { ...result, [keyword]: mapped }
      }
      continue
    }

    if (isSchema(child)) {
      const mapped = normalizeForAjv(child)
      if (mapped !== child) {
        result = { ...result, [keyword]: mapped }
      }
    }
  }

  return result
}

function collapseNullableUnion(schema: JSONSchema): JSONSchema {
  const branches = schema.anyOf
  if (!Array.isArray(branches) || branches.length !== 2) {
    return schema
  }

  const nullIndex = branches.findIndex(isNullOnlySchema)
  if (nullIndex === -1) {
    return schema
  }

  const other = branches[nullIndex === 0 ? 1 : 0]
  if (!isSchema(other) || typeof other.type !== 'string' || TYPE_AGNOSTIC.some(keyword => keyword in other)) {
    return schema
  }

  // Options set on the union itself (a description, say) outrank the branch's own.
  const { anyOf: _, ...unionOptions } = schema
  return { ...other, ...unionOptions, type: [other.type, 'null'] }
}

function collapseLiteralUnion(schema: JSONSchema): JSONSchema {
  const branches = schema.anyOf
  if (!Array.isArray(branches) || branches.length < 2) {
    return schema
  }

  const values: unknown[] = []
  const types = new Set<string>()
  for (const branch of branches) {
    if (!isLiteralBranch(branch)) {
      return schema
    }
    values.push(branch.const)
    types.add(branch.type)
  }

  const { anyOf: _, ...unionOptions } = schema
  if (types.size === 1) {
    return { ...unionOptions, type: [...types][0], enum: values }
  }
  return { ...unionOptions, enum: values }
}

/** `{ type: 'null' }` and nothing else — a branch carrying constraints is not a plain null. */
function isNullOnlySchema(schema: unknown): boolean {
  return isSchema(schema) && schema.type === 'null' && Object.keys(schema).length === 1
}

/** `{ const, type }` and nothing else. A description or minLength on a branch is enough to refuse the collapse. */
function isLiteralBranch(schema: unknown): schema is JSONSchema & { const: unknown; type: string } {
  return isSchema(schema) && 'const' in schema && typeof schema.type === 'string' && Object.keys(schema).length === 2
}

function isSchema(value: unknown): value is JSONSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSchemaRecord(value: unknown): value is Record<string, JSONSchema> {
  return isSchema(value)
}

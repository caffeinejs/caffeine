import type { TSchema } from '@sinclair/typebox'

// Drops the keys a schema forbids, as Ajv's `removeAdditional` does: at any depth, but only where an object says
// `additionalProperties: false` and declares no `patternProperties`. TypeBox's `Value.Clean` drops every undeclared key
// everywhere instead, so a value validated here would lose data that a value validated by Ajv keeps.
//
// A nullable object counts as the object, as HTTP's `normalizeForAjv` collapses it for Ajv. Inside any other union, or
// an intersection, nothing is dropped: Ajv's own result there depends on the branch it tried first.
export function removeAdditional(schema: TSchema, value: unknown): void {
  visit(schema as Node, value)
}

type Node = Record<string, unknown>

function visit(schema: Node, value: unknown): void {
  const nullable = nullableBranch(schema)
  if (nullable !== undefined) {
    visit(nullable, value)
    return
  }

  if (Array.isArray(value)) {
    const { items } = schema
    if (Array.isArray(items)) {
      items.forEach((item, i) => isNode(item) && visit(item, value[i]))
    } else if (isNode(items)) {
      for (const element of value) {
        visit(items, element)
      }
    }
    return
  }

  if (typeof value !== 'object' || value === null) {
    return
  }

  const record = value as Record<string, unknown>
  const properties = isNode(schema.properties) ? schema.properties : {}
  const { additionalProperties } = schema
  const forbids = additionalProperties === false && schema.patternProperties === undefined

  for (const key of Object.keys(record)) {
    if (Object.hasOwn(properties, key)) {
      const property = properties[key]
      if (isNode(property)) {
        visit(property, record[key])
      }
    } else if (forbids) {
      delete record[key]
    } else if (isNode(additionalProperties)) {
      visit(additionalProperties, record[key])
    }
  }
}

// The other branch of `anyOf: [X, { type: 'null' }]`, in either order.
function nullableBranch(schema: Node): Node | undefined {
  const { anyOf } = schema
  if (!Array.isArray(anyOf) || anyOf.length !== 2) {
    return undefined
  }

  const [first, second] = anyOf as unknown[]
  if (isNullOnly(second) && isNode(first)) {
    return first
  }
  if (isNullOnly(first) && isNode(second)) {
    return second
  }
  return undefined
}

function isNullOnly(value: unknown): boolean {
  return isNode(value) && value.type === 'null' && Object.keys(value).length === 1
}

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

import { type AnySchema, type SchemaIO, toJSONSchema } from '@caffeinejs/std/schema'

import { ErrOpenAPISchemaConflict } from '../errors.js'
import type { SchemaObject } from '../spec/spec.js'

/**
 * Collects the schemas a document references and hoists the named ones into `components.schemas`.
 *
 * Naming comes from a schema's own `$id` and nothing else. That is the whole contract: a schema declared with
 * an `$id` of `Pet` produces `components.schemas.Pet`, and every use of it becomes a `$ref`, because the
 * schema already had a place to carry its name and nobody was using it.
 */
export class ComponentRegistry {
  readonly #schemas = new Map<string, SchemaObject>()
  readonly #dedupe: boolean
  readonly #byShape = new Map<string, string>()
  readonly #nameFor: (schema: SchemaObject) => string | undefined

  constructor(dedupe = false, nameFor: (schema: SchemaObject) => string | undefined = componentName) {
    this.#dedupe = dedupe
    this.#nameFor = nameFor
  }

  /**
   * Converts an authored schema and returns what an operation should reference — a `$ref` when the schema
   * carries an `$id`, the schema itself otherwise.
   *
   * @param io - `input` for request slots, `output` for responses. The projections differ: a property with a
   *   default is optional on the way in and always present on the way out.
   * @param context - Where the schema is attached (`POST /pets body`), used to locate a conversion failure.
   */
  register(schema: AnySchema, io: SchemaIO, context: string): SchemaObject {
    const converted = toJSONSchema(schema, io, context)
    return this.#hoist(converted)
  }

  /** The `components.schemas` map, or `undefined` when nothing was named. */
  build(): Record<string, SchemaObject> | undefined {
    if (this.#schemas.size === 0) {
      return undefined
    }

    return Object.fromEntries([...this.#schemas].sort(([a], [b]) => a.localeCompare(b)))
  }

  #hoist(schema: SchemaObject): SchemaObject {
    // `$defs` reach the document as components too, so a schema that composes named sub-schemas does not
    // bury them where a consumer cannot name them.
    const defs = schema.$defs
    if (isRecord(defs)) {
      for (const [name, def] of Object.entries(defs)) {
        if (isRecord(def)) {
          this.#store(name, this.#walk(def))
        }
      }
    }

    const walked = this.#walk(stripDefs(schema))
    const name = this.#nameFor(schema)

    if (name === undefined) {
      return this.#dedupe ? this.#maybeDedupe(walked) : walked
    }

    this.#store(name, walked)

    return { $ref: `#/components/schemas/${name}` }
  }

  // Depth-first, so a nested `$id` is hoisted and replaced before its parent is stored.
  #walk(schema: SchemaObject): SchemaObject {
    const out: SchemaObject = {}

    for (const [key, value] of Object.entries(schema)) {
      if (key === '$id' || key === '$defs') {
        continue
      }

      if (Array.isArray(value)) {
        out[key] = value.map(item => (isRecord(item) && isSchemaLike(key) ? this.#hoist(item) : item))
      } else if (isRecord(value)) {
        out[key] = isSchemaLike(key)
          ? this.#hoist(value)
          : isSchemaMap(key)
            ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, isRecord(v) ? this.#hoist(v) : v]))
            : value
      } else {
        out[key] = value
      }
    }

    return out
  }

  #store(name: string, schema: SchemaObject): void {
    const existing = this.#schemas.get(name)

    if (existing !== undefined && !sameShape(existing, schema)) {
      throw new ErrOpenAPISchemaConflict(name)
    }

    this.#schemas.set(name, schema)
  }

  #maybeDedupe(schema: SchemaObject): SchemaObject {
    // Only worth naming when it is a real object type; hoisting `{ type: 'string' }` produces noise, not reuse.
    if (schema.type !== 'object' || !isRecord(schema.properties)) {
      return schema
    }

    const shape = JSON.stringify(schema)
    const existing = this.#byShape.get(shape)
    if (existing !== undefined) {
      return { $ref: `#/components/schemas/${existing}` }
    }

    const name = `Schema${this.#byShape.size + 1}`
    this.#byShape.set(shape, name)
    this.#schemas.set(name, schema)

    return { $ref: `#/components/schemas/${name}` }
  }
}

/**
 * The component name for a schema: the last segment of its `$id`.
 *
 * An `$id` is a URI, so `https://example.com/schemas/Pet` and a bare `Pet` both name `Pet` — which is what a
 * consumer renders and what a client generator turns into a type name.
 */
export function componentName(schema: SchemaObject): string | undefined {
  const id = schema.$id
  if (typeof id !== 'string' || id === '') {
    return undefined
  }

  const segment = id
    .split(/[/#]/)
    .filter(part => part !== '')
    .pop()

  return segment === undefined || segment === '' ? undefined : segment
}

/** Keywords whose value is a single subschema. */
const SCHEMA_KEYWORDS = new Set([
  'additionalItems',
  'additionalProperties',
  'contains',
  'else',
  'if',
  'items',
  'not',
  'propertyNames',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
])

/** Keywords whose value is an array of subschemas. */
const SCHEMA_LIST_KEYWORDS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems'])

/** Keywords whose value maps names to subschemas. */
const SCHEMA_RECORD_KEYWORDS = new Set(['properties', 'patternProperties', 'dependentSchemas'])

function isSchemaLike(key: string): boolean {
  return SCHEMA_KEYWORDS.has(key) || SCHEMA_LIST_KEYWORDS.has(key)
}

function isSchemaMap(key: string): boolean {
  return SCHEMA_RECORD_KEYWORDS.has(key)
}

function stripDefs(schema: SchemaObject): SchemaObject {
  if (!('$defs' in schema)) {
    return schema
  }

  const { $defs: _, ...rest } = schema
  return rest
}

function sameShape(a: SchemaObject, b: SchemaObject): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function isRecord(value: unknown): value is SchemaObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

import { ErrSchemaConversion, ErrSchemaNotRepresentable } from './errors.js'
import { type AnySchema, isStandardJSONSchema, isTypeBoxSchema, schemaVendor } from './schema.js'

/** A plain JSON Schema object, the only shape a JSON Schema validator such as Ajv can consume. */
export type JSONSchema = Record<string, unknown>

/**
 * Which side of the schema to project.
 *
 * `input` describes what arrives on the wire, so it is what request validation needs: an optional property with a
 * default stays optional, because the client is not required to send it. `output` describes the validated result,
 * where that same property is always present — the right projection for a response.
 */
export type SchemaIO = 'input' | 'output'

/**
 * Ajv is configured for draft-07 in Fastify, and it rejects a schema whose `$schema` names a draft it has no
 * meta-schema for.
 */
const JSON_SCHEMA_TARGET = 'draft-07'

/** Every type JSON Schema defines. Anything else is a TypeBox-only (or converter-only) invention. */
const JSON_SCHEMA_TYPES = new Set(['null', 'boolean', 'object', 'array', 'number', 'string', 'integer'])

/** Keywords whose value is a single subschema. */
const SCHEMA_KEYWORDS = [
  'additionalItems',
  'additionalProperties',
  'contains',
  'else',
  'if',
  'not',
  'propertyNames',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
] as const

/** Keywords whose value is an array of subschemas. `items` is either, and is handled on its own. */
const SCHEMA_LIST_KEYWORDS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'] as const

/** Keywords whose value maps names to subschemas. */
const SCHEMA_RECORD_KEYWORDS = ['$defs', 'definitions', 'dependentSchemas', 'patternProperties', 'properties'] as const

/**
 * Converts a schema to a plain JSON Schema object.
 *
 * A TypeBox schema is returned as-is: it already *is* JSON Schema, and its `Kind` markers are symbols that no JSON
 * Schema consumer can see. A Standard Schema is converted through the spec's own `jsonSchema` converter, so any
 * library implementing it (zod v4 today) works without Caffeine knowing that library.
 *
 * Conversion is lossy by nature — see {@link ErrSchemaConversion} and `docs/internal/schema-dialect.md`. Anything a
 * JSON Schema cannot express is either rejected here or absent from the result; it is never executed at request
 * time, because Ajv, not the originating library, does the validating.
 *
 * Whichever branch runs, the result is checked for types JSON Schema does not define. TypeBox will happily build
 * `{ type: 'undefined' }` — its own `Value` understands it — and Ajv then rejects the entire route with a message
 * that names neither the builder nor the fix. Catching it here keeps the contract simple: what comes back compiles,
 * or nothing comes back.
 *
 * @param context - Where the schema is attached (`POST /pets body`), used to make a failure locatable.
 * @throws ErrSchemaConversion when the schema cannot be represented as JSON Schema.
 * @throws ErrSchemaNotRepresentable when the result names a type JSON Schema does not define.
 */
export function toJSONSchema(schema: AnySchema, io: SchemaIO, context: string): JSONSchema {
  if (isTypeBoxSchema(schema)) {
    assertRepresentable(schema as JSONSchema, context, '')
    return schema as JSONSchema
  }

  const vendor = schemaVendor(schema)

  if (!isStandardJSONSchema(schema)) {
    throw new ErrSchemaConversion(
      vendor,
      context,
      `the "${vendor}" schema does not implement the Standard Schema JSON Schema conversion`,
    )
  }

  let converted: JSONSchema
  try {
    converted = schema['~standard'].jsonSchema[io]({ target: JSON_SCHEMA_TARGET })
  } catch (cause) {
    throw new ErrSchemaConversion(vendor, context, describe(cause), cause)
  }

  const stripped = stripDialect(converted)

  assertRepresentable(stripped, context, '')

  return stripped
}

/**
 * Drops the `$schema` declaration. Converters emit it, and Ajv then refuses to build the validator because it has
 * no meta-schema registered under that URI — a failure at `listen` time for an otherwise valid schema.
 */
function stripDialect(schema: JSONSchema): JSONSchema {
  if (!('$schema' in schema)) {
    return schema
  }

  const { $schema: _, ...rest } = schema
  return rest
}

/**
 * Walks the schema and throws if any `type` is not one of the seven JSON Schema types.
 *
 * `$t.Undefined` remains valid in a configuration schema: TypeBox's `Value` understands `{ type: 'undefined' }`.
 * It is only this conversion — the HTTP path — that rejects it, because Ajv will not compile it.
 */
function assertRepresentable(schema: JSONSchema, context: string, path: string): void {
  const type = schema.type
  if (typeof type === 'string') {
    assertJsonType(type, context, path)
  } else if (Array.isArray(type)) {
    for (const member of type) {
      if (typeof member === 'string') {
        assertJsonType(member, context, path)
      }
    }
  }

  for (const keyword of SCHEMA_KEYWORDS) {
    const child = schema[keyword]
    if (isSchema(child)) {
      assertRepresentable(child, context, joinPath(path, keyword))
    }
  }

  for (const keyword of SCHEMA_LIST_KEYWORDS) {
    const list = schema[keyword]
    if (!Array.isArray(list)) {
      continue
    }
    for (let i = 0; i < list.length; i++) {
      const child = list[i]
      if (isSchema(child)) {
        assertRepresentable(child, context, `${joinPath(path, keyword)}[${i}]`)
      }
    }
  }

  for (const keyword of SCHEMA_RECORD_KEYWORDS) {
    const record = schema[keyword]
    if (!isSchema(record)) {
      continue
    }
    for (const [key, child] of Object.entries(record)) {
      if (isSchema(child)) {
        assertRepresentable(child, context, joinPath(path, `${keyword}.${key}`))
      }
    }
  }

  const items = schema.items
  if (Array.isArray(items)) {
    for (let i = 0; i < items.length; i++) {
      const child = items[i]
      if (isSchema(child)) {
        assertRepresentable(child, context, `${joinPath(path, 'items')}[${i}]`)
      }
    }
  } else if (isSchema(items)) {
    assertRepresentable(items, context, joinPath(path, 'items'))
  }
}

function assertJsonType(type: string, context: string, path: string): void {
  if (JSON_SCHEMA_TYPES.has(type)) {
    return
  }
  throw new ErrSchemaNotRepresentable(context, path, type, ...solutionsFor(type))
}

function solutionsFor(jsonType: string): string[] {
  if (jsonType === 'undefined') {
    return [
      'Use "$t.Optional(x)" to allow the property to be absent, which is how JSON Schema expresses absence',
      'Use "$t.Nullable(x)" to allow an explicit null',
      'Use "$t.MaybeEmpty(x)" to allow both',
    ]
  }
  return [
    'Replace the unrepresentable type with a JSON Schema type that Ajv can compile',
    'Keep TypeBox-only types such as "$t.Undefined" on configuration schemas, which TypeBox Value can check',
  ]
}

function joinPath(parent: string, child: string): string {
  return parent === '' ? child : `${parent}.${child}`
}

function isSchema(value: unknown): value is JSONSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

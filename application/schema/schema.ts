import { Kind, type Static, type StaticDecode, type TSchema } from '@sinclair/typebox'
import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec'

import type { SchemaIO } from './json_schema.js'

/**
 * Any schema Caffeine accepts: a TypeBox schema (the curated `$t` dialect, see `./t.js`) or any
 * {@link https://standardschema.dev | Standard Schema} — the cross-library validation interface implemented
 * natively by zod v4, valibot, arktype and others.
 *
 * TypeBox is the first-class dialect because a TypeBox schema *is* a JSON Schema: one declaration validates,
 * types, and (later) documents. Standard Schema libraries are fully supported wherever Caffeine runs the
 * validator itself — configuration, and the request of an HTTP route — and supported to the extent they convert to
 * JSON Schema where a JSON Schema is all that is read: a route's response, which Fastify serializes, and the
 * OpenAPI document.
 */
export type AnySchema = TSchema | StandardSchemaV1

/**
 * Infers the validated output type carried by an {@link AnySchema}.
 *
 * `StaticDecode` rather than `Static`: a codec such as `$t.List` accepts text and yields a list, and the type a
 * caller sees must be what validation *produced*, not what it was willing to accept. For a schema declaring no
 * codec the two are the same type.
 */
export type InferSchema<S extends AnySchema> = S extends TSchema
  ? StaticDecode<S>
  : S extends StandardSchemaV1
    ? StandardSchemaV1.InferOutput<S>
    : never

/**
 * Infers what crosses the wire for an {@link AnySchema}, on the side `io` names: a TypeBox schema's encoded form,
 * where a codec such as `$t.Duration()` is still text, or a Standard Schema's input or output.
 *
 * A client sends and receives this. A handler, handed the values validation produced, sees {@link InferSchema}.
 */
export type InferWire<S extends AnySchema, IO extends SchemaIO> = S extends TSchema
  ? Static<S>
  : S extends StandardSchemaV1
    ? IO extends 'input'
      ? StandardSchemaV1.InferInput<S>
      : StandardSchemaV1.InferOutput<S>
    : never

/** A normalized validation failure. Paths are dotted (`server.port`) whatever the source library. */
export interface SchemaIssue {
  path: string
  message: string
  code?: string
}

/**
 * Narrows to a TypeBox schema. TypeBox brands every schema with a `Symbol(TypeBox.Kind)` property; being a symbol
 * it never reaches `JSON.stringify` and stays invisible to JSON Schema consumers such as Ajv.
 */
export function isTypeBoxSchema(schema: unknown): schema is TSchema {
  return typeof schema === 'object' && schema !== null && Kind in schema
}

/** Narrows to a Standard Schema of any vendor. */
export function isStandardSchema(schema: unknown): schema is StandardSchemaV1 {
  return typeof schema === 'object' && schema !== null && '~standard' in schema
}

/**
 * Narrows to a Standard Schema that also implements the spec's JSON Schema conversion, which is how a foreign
 * library becomes usable on an HTTP route. zod v4 implements it; libraries that do not cannot be compiled for
 * Fastify.
 */
export function isStandardJSONSchema(schema: unknown): schema is StandardJSONSchemaV1 {
  return isStandardSchema(schema) && 'jsonSchema' in schema['~standard']
}

/** The implementing library — the Standard Schema vendor name, or `typebox` for the native dialect. */
export function schemaVendor(schema: AnySchema): string {
  return isStandardSchema(schema) ? schema['~standard'].vendor : 'typebox'
}

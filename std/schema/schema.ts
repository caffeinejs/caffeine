import { Kind, type Static, type TSchema } from '@sinclair/typebox'
import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec'

/**
 * Any schema Caffeine accepts: a TypeBox schema (the curated `$t` dialect, see `./t.js`) or any
 * {@link https://standardschema.dev | Standard Schema} — the cross-library validation interface implemented
 * natively by zod v4, valibot, arktype and others.
 *
 * TypeBox is the first-class dialect because a TypeBox schema *is* a JSON Schema: one declaration validates,
 * types, and (later) documents. Standard Schema libraries are fully supported wherever Caffeine runs the
 * validator itself — configuration — and supported to the extent they convert to JSON Schema where validation is
 * delegated to Fastify's Ajv, which cannot execute a foreign validator.
 */
export type AnySchema = TSchema | StandardSchemaV1

/** Infers the validated output type carried by an {@link AnySchema}. */
export type InferSchema<S extends AnySchema>
  = S extends TSchema ? Static<S>
    : S extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<S>
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

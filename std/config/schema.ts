import type { TSchema } from '@sinclair/typebox'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { AnySchema, InferSchema } from '../schema/schema.js'
import { validateSchema } from '../schema/validate.js'
import { ErrConfigValidation } from './errors.js'

/**
 * A configuration schema: either the `$t` dialect (TypeBox, the first-class choice) or any
 * {@link https://standardschema.dev | Standard Schema} — zod v4, valibot, arktype and others.
 *
 * Configuration is the one place where a foreign library is supported without reservation: Caffeine calls the
 * library's own validator, so refinements and transforms run exactly as authored. This is unlike HTTP routes, where
 * validation is delegated to Fastify's Ajv and the schema must survive a projection to JSON Schema.
 *
 * The type parameter is phantom — it names the validated shape for call sites that declare a schema up front.
 */
export type ConfigSchema<T = unknown> = TSchema | StandardSchemaV1<unknown, T>

/** Infers the validated output type carried by a {@link ConfigSchema}. */
export type InferConfig<S extends AnySchema> = InferSchema<S>

/**
 * Validates and returns the typed configuration. Validation is synchronous: a schema whose validator returns a
 * `Promise` (async refinement) is rejected, because configuration is materialized synchronously (the refresh
 * assignment and the server-options factory both read the validated value without awaiting).
 *
 * Keys no schema declares are dropped, not rejected — the raw configuration is the union of every provider, so an
 * environment variable that belongs to some other tool must not fail startup.
 */
export function validateConfig<T>(schema: ConfigSchema<T>, input: unknown): T {
  const result = validateSchema(schema as AnySchema, input)

  if (!result.ok) {
    throw new ErrConfigValidation(result.issues)
  }

  return result.value as T
}

import type { TSchema } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import type { StandardSchemaV1 } from '@standard-schema/spec'

import { isTypeBoxSchema, type AnySchema, type InferSchema } from '../schema/schema.js'
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
 * The schema an application that never declared one gets. Configuration is now unconditional — features read
 * their own slices from the tree whether or not the application described it — so the root still needs
 * *something* to validate against, and the honest answer for an undeclared shape is to pass it through
 * untouched rather than invent constraints.
 */
export const passthroughConfigSchema: StandardSchemaV1<unknown, unknown> = {
  '~standard': {
    version: 1,
    vendor: 'caffeine',
    validate: value => ({ value }),
  },
}

/**
 * The defaults a schema declares, as a tree, for registration as a configuration source.
 *
 * A schema `default` only fills a value that is **absent**, and a feature writes its own defaults into the tree
 * as real values — so `$t.Number({ default: 9999 })` on `server.port` would otherwise never be reached. Lifting
 * the declared defaults into their own band puts them in the same merge as everything else, where they beat the
 * framework's and lose to a builder call.
 *
 * Only the `$t` dialect is introspected. A foreign Standard Schema is validated by its own library and exposes
 * nothing to walk, so its defaults reach the root tree the way they always did and no further — the same
 * limitation {@link secretPaths} has.
 */
export function declaredDefaults(schema: ConfigSchema<unknown>): Record<string, unknown> {
  if (!isTypeBoxSchema(schema)) {
    return {}
  }

  // `Value.Default` writes into what it is given, so it gets a fresh object rather than anything shared.
  const defaults = Value.Default(schema, {})

  return defaults !== null && typeof defaults === 'object' ? (defaults as Record<string, unknown>) : {}
}

/**
 * Validates and returns the typed configuration. Validation is synchronous: a schema whose validator returns a
 * `Promise` (async refinement) is rejected, because configuration is materialized synchronously (the refresh
 * assignment and the server-options factory both read the validated value without awaiting).
 *
 * Keys no schema declares are dropped, not rejected — the raw configuration is the union of every provider, so an
 * environment variable that belongs to some other tool must not fail startup.
 *
 * Codecs run here, and only here. Configuration is where values arrive as text — an environment variable, a
 * command-line argument — so a schema declaring `$t.List` or `$t.JSON` is decoded as part of validating it. The
 * same function serves the root schema and every feature slice, so a feature gets codecs without asking. A
 * Standard Schema is unaffected: it runs its own validator, transforms included, exactly as authored.
 */
export function validateConfig<T>(schema: ConfigSchema<T>, input: unknown): T {
  const result = validateSchema(schema as AnySchema, input, { decode: true })

  if (!result.ok) {
    throw new ErrConfigValidation(result.issues)
  }

  return result.value as T
}

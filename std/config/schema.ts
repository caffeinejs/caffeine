import type { StandardSchemaV1 } from '@standard-schema/spec'
import { ErrConfigValidation } from './errors.js'
import type { SchemaIssue } from './types.js'

/**
 * A configuration schema is any {@link https://standardschema.dev | Standard Schema} — the cross-library
 * validation interface implemented natively by zod v4, valibot, arktype, and others. Libraries that are not
 * yet Standard-Schema-native (e.g. TypeBox) are wrapped by an adapter (see `./adapters/typebox.ts`).
 */
export type ConfigSchema<T = unknown> = StandardSchemaV1<unknown, T>

/** Infers the validated output type carried by a {@link ConfigSchema}. */
export type InferConfig<S extends ConfigSchema> = StandardSchemaV1.InferOutput<S>

/**
 * Validates and returns the typed configuration. Validation is synchronous: a schema whose validator returns a
 * `Promise` (async refinement) is rejected, because configuration is materialized synchronously (the refresh
 * assignment and the server-options factory both read the validated value without awaiting).
 */
export function validateConfig<T>(schema: ConfigSchema<T>, input: unknown): T {
  const result = schema['~standard'].validate(input)

  if (result instanceof Promise) {
    throw new ErrConfigValidation([{ path: '', message: 'Async schema validation is not supported for configuration' }])
  }

  if (result.issues !== undefined) {
    throw new ErrConfigValidation(result.issues.map(toSchemaIssue))
  }

  return result.value
}

function toSchemaIssue(issue: StandardSchemaV1.Issue): SchemaIssue {
  const path = (issue.path ?? [])
    .map(segment => String(typeof segment === 'object' ? segment.key : segment))
    .join('.')
  return { path, message: issue.message }
}

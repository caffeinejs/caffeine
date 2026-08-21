import type { TSchema } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { type AnySchema, type InferSchema, isTypeBoxSchema, type SchemaIssue } from './schema.js'

export type SchemaValidationResult<T>
  = | { ok: true, value: T }
    | { ok: false, issues: SchemaIssue[] }

/**
 * Validates `input` synchronously and returns the coerced value or normalized issues.
 *
 * Used where Caffeine owns validation — configuration above all, which must be materialized before anything can be
 * injected and therefore cannot await. HTTP routes do *not* go through here: their schemas are compiled to JSON
 * Schema once and Fastify's Ajv validates every request.
 *
 * A TypeBox schema runs the pipeline below. A Standard Schema runs its own library's validator, so refinements and
 * transforms behave exactly as the author wrote them.
 */
export function validateSchema<S extends AnySchema>(schema: S, input: unknown): SchemaValidationResult<InferSchema<S>> {
  if (isTypeBoxSchema(schema)) {
    return validateTypeBox(schema, input) as SchemaValidationResult<InferSchema<S>>
  }
  return validateStandard(schema as StandardSchemaV1, input) as SchemaValidationResult<InferSchema<S>>
}

/**
 * Clone so the caller's input is never mutated, then fill defaults, coerce (`'8080'` becomes `8080`, which is the
 * only way environment variables can satisfy a typed schema), drop undeclared keys, and check.
 *
 * `Value.Clean` is what makes unknown keys *dropped rather than rejected*, matching how object schemas behave in
 * zod and valibot. Without it a single unrelated environment variable would fail startup.
 */
function validateTypeBox(schema: TSchema, input: unknown): SchemaValidationResult<unknown> {
  let value = Value.Clone(input)
  value = Value.Default(schema, value)
  value = Value.Convert(schema, value)
  value = Value.Clean(schema, value)

  if (Value.Check(schema, value)) {
    return { ok: true, value }
  }

  const issues = [...Value.Errors(schema, value)].map<SchemaIssue>(error => ({
    path: pointerToDotted(error.path),
    message: error.message,
    code: String(error.type),
  }))

  return { ok: false, issues }
}

function validateStandard(schema: StandardSchemaV1, input: unknown): SchemaValidationResult<unknown> {
  const result = schema['~standard'].validate(input)

  if (result instanceof Promise) {
    return {
      ok: false,
      issues: [{
        path: '',
        message: `Async schema validation is not supported: the "${schema['~standard'].vendor}" schema returned a Promise`,
      }],
    }
  }

  if (result.issues) {
    return { ok: false, issues: result.issues.map(toSchemaIssue) }
  }

  return { ok: true, value: result.value }
}

function toSchemaIssue(issue: StandardSchemaV1.Issue): SchemaIssue {
  const path = (issue.path ?? [])
    .map(segment => String(typeof segment === 'object' ? segment.key : segment))
    .join('.')

  return { path, message: issue.message }
}

/** TypeBox reports a JSON Pointer (`/server/port`); the rest of Caffeine speaks dotted paths (`server.port`). */
function pointerToDotted(pointer: string): string {
  return pointer.replace(/^\//, '').replaceAll('/', '.')
}

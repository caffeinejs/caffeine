import type { TSchema } from '@sinclair/typebox'
import { HasTransform, TransformDecodeError, Value } from '@sinclair/typebox/value'
import type { StandardSchemaV1 } from '@standard-schema/spec'

import { type AnySchema, type InferSchema, isTypeBoxSchema, type SchemaIssue } from './schema.js'

export type SchemaValidationResult<T> = { ok: true; value: T } | { ok: false; issues: SchemaIssue[] }

export interface SchemaValidateOptions {
  /**
   * Runs the TypeBox codecs a schema declares — `$t.List`, `$t.JSON` — after the value has been checked.
   *
   * Off by default, and deliberately a caller's decision rather than a property of the schema. Configuration
   * turns it on because its values arrive as text from environments and command lines; a message payload does
   * not, and must not start decoding because some other part of the framework wanted it to.
   */
  decode?: boolean
}

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
export function validateSchema<S extends AnySchema>(
  schema: S,
  input: unknown,
  options: SchemaValidateOptions = {},
): SchemaValidationResult<InferSchema<S>> {
  if (isTypeBoxSchema(schema)) {
    return validateTypeBox(schema, input, options.decode === true) as SchemaValidationResult<InferSchema<S>>
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
function validateTypeBox(schema: TSchema, input: unknown, decode: boolean): SchemaValidationResult<unknown> {
  let value = Value.Clone(input)
  value = Value.Default(schema, value)
  value = Value.Convert(schema, value)
  value = Value.Clean(schema, value)

  if (Value.Check(schema, value)) {
    return decode ? decodeCodecs(schema, value) : { ok: true, value }
  }

  const issues = [...Value.Errors(schema, value)].map<SchemaIssue>(error => ({
    path: pointerToDotted(error.path),
    message: error.message,
    code: String(error.type),
  }))

  return { ok: false, issues }
}

/**
 * Runs the codecs, last, on a value that has already been checked.
 *
 * `Value.Decode` validates the *encoded* form and never re-examines what a codec returned, which is why each
 * codec checks its own output — see `decodeInto` in `./t.js`. A codec that rejects throws, and the throw is
 * turned into an ordinary issue so a bad `DB={"host":123}` reads like any other validation failure instead of
 * escaping as a raw `TypeBoxError`.
 *
 * Schemas without a codec skip the walk entirely, so declaring none costs nothing.
 */
function decodeCodecs(schema: TSchema, value: unknown): SchemaValidationResult<unknown> {
  if (!HasTransform(schema, [])) {
    return { ok: true, value }
  }

  try {
    return { ok: true, value: Value.Decode(schema, value) }
  } catch (error) {
    return { ok: false, issues: [decodeIssue(error)] }
  }
}

function decodeIssue(error: unknown): SchemaIssue {
  if (error instanceof TransformDecodeError) {
    return {
      path: pointerToDotted(error.path),
      message: error.error.message,
      code: 'Decode',
    }
  }

  return { path: '', message: error instanceof Error ? error.message : String(error), code: 'Decode' }
}

function validateStandard(schema: StandardSchemaV1, input: unknown): SchemaValidationResult<unknown> {
  const result = schema['~standard'].validate(input)

  if (result instanceof Promise) {
    return {
      ok: false,
      issues: [
        {
          path: '',
          message: `Async schema validation is not supported: the "${schema['~standard'].vendor}" schema returned a Promise`,
        },
      ],
    }
  }

  if (result.issues) {
    return { ok: false, issues: result.issues.map(toSchemaIssue) }
  }

  return { ok: true, value: result.value }
}

function toSchemaIssue(issue: StandardSchemaV1.Issue): SchemaIssue {
  const path = (issue.path ?? []).map(segment => String(typeof segment === 'object' ? segment.key : segment)).join('.')

  return { path, message: issue.message }
}

/** TypeBox reports a JSON Pointer (`/server/port`); the rest of Caffeine speaks dotted paths (`server.port`). */
function pointerToDotted(pointer: string): string {
  return pointer.replace(/^\//, '').replaceAll('/', '.')
}

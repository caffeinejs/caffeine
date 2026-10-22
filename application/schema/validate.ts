import type { TSchema } from '@sinclair/typebox'
import { TypeCompiler } from '@sinclair/typebox/compiler'
import type { ValueError } from '@sinclair/typebox/errors'
import { HasTransform, TransformDecode, TransformDecodeError, TransformEncode, Value } from '@sinclair/typebox/value'
import type { StandardSchemaV1 } from '@standard-schema/spec'

import { removeAdditional } from './_additional.js'
import { registerFormats } from './_formats.js'
import { materializeObjects } from './_materialize.js'
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
  /**
   * Creates the object nodes the schema declares and the input omits, so a block whose fields all carry defaults
   * materializes from nothing rather than failing as a missing required property.
   *
   * Off by default, and a caller's decision for the same reason {@link decode} is. Configuration turns it on
   * because a block nobody configured should still resolve to its defaults; a message payload must not gain a
   * node the sender never sent.
   */
  materialize?: boolean
}

/**
 * Validates `input` synchronously and returns the coerced value or normalized issues.
 *
 * Used where Caffeine owns validation of a single value — configuration above all, which must be materialized before
 * anything can be injected and therefore cannot await. An HTTP route validates many values against one schema, so it
 * uses {@link compileValidator} instead.
 *
 * A TypeBox schema runs the pipeline below. A Standard Schema runs its own library's validator, so refinements and
 * transforms behave exactly as the author wrote them.
 */
export function validateSchema<S extends AnySchema>(
  schema: S,
  input: unknown,
  options: SchemaValidateOptions = {},
): SchemaValidationResult<InferSchema<S>> {
  registerFormats()

  if (isTypeBoxSchema(schema)) {
    return validateTypeBox(schema, input, options) as SchemaValidationResult<InferSchema<S>>
  }
  return validateStandard(schema as StandardSchemaV1, input) as SchemaValidationResult<InferSchema<S>>
}

/**
 * Validates one value against the schema a validator was compiled from. A TypeBox schema answers at once; a Standard
 * Schema may answer with a promise, when its library validates asynchronously.
 */
export type SchemaValidator<T> = (input: unknown) => SchemaValidationResult<T> | Promise<SchemaValidationResult<T>>

/**
 * Builds a validator for one schema, to run on many values: whatever depends on the schema alone is done here, once.
 *
 * A TypeBox schema is compiled to code, and each value is then handled as Fastify's Ajv handles a request: its declared
 * defaults are filled in, its types converted (`'8080'` becomes `8080`, `'a'` becomes `['a']` where an array is
 * declared, and, unlike Ajv, `'1.9'` becomes `1` where an integer is), and its keys dropped where an object says `additionalProperties: false`, a nullable object included, though
 * never inside another union or an intersection. It is then checked, and its codecs decoded. A Standard Schema runs its own library's validator. Either
 * way a failure reports its first issue only, so the report on a large invalid value is no larger than on a small one.
 *
 * The value is worked on in place, not copied: hand it one nobody else holds, such as a request's parsed body.
 *
 * @throws TypeCompilerUnknownTypeError when the TypeBox schema holds a kind TypeBox cannot check, such as
 * `$t.Unsafe(...)`.
 */
export function compileValidator<S extends TSchema>(
  schema: S,
): (input: unknown) => SchemaValidationResult<InferSchema<S>>
export function compileValidator<S extends AnySchema>(schema: S): SchemaValidator<InferSchema<S>>
export function compileValidator<S extends AnySchema>(schema: S): SchemaValidator<InferSchema<S>> {
  if (isTypeBoxSchema(schema)) {
    return compileTypeBox(schema) as SchemaValidator<InferSchema<S>>
  }
  return compileStandard(schema as StandardSchemaV1) as SchemaValidator<InferSchema<S>>
}

/**
 * Whether a schema holds a codec, such as `$t.Duration()` or `$t.List()`: a TypeBox transform, which checking a value
 * against the schema's JSON Schema leaves undecoded. A Standard Schema answers `false`; its own validator runs
 * whatever it transforms.
 */
export function hasCodec(schema: AnySchema): boolean {
  return isTypeBoxSchema(schema) && HasTransform(schema, [])
}

/**
 * Builds the function that turns a decoded value back into what the schema reads, running its codecs the other way:
 * the `Duration` `5000` becomes `'5s'`. The encoded value is not checked against the schema.
 *
 * `undefined` when there is nothing to encode: a schema holding no codec, or a Standard Schema, whose interface has no
 * encoding.
 */
export function compileEncoder(schema: AnySchema): ((value: unknown) => unknown) | undefined {
  if (!hasCodec(schema)) {
    return undefined
  }
  return value => TransformEncode(schema as TSchema, [], value)
}

function compileTypeBox(schema: TSchema): SchemaValidator<unknown> {
  registerFormats()

  const checker = TypeCompiler.Compile(schema)
  const decodes = HasTransform(schema, [])

  return input => {
    let value = Value.Default(schema, input)
    value = Value.Convert(schema, value)
    removeAdditional(schema, value)

    if (!checker.Check(value)) {
      const first = checker.Errors(value).First()
      return {
        ok: false,
        issues: [first === undefined ? { path: '', message: 'Expected a valid value' } : errorIssue(first)],
      }
    }

    if (!decodes) {
      return { ok: true, value }
    }

    try {
      // Checked just above, so `TransformDecode` skips the check `Value.Decode` would run again.
      return { ok: true, value: TransformDecode(schema, [], value) }
    } catch (error) {
      return { ok: false, issues: [decodeIssue(error)] }
    }
  }
}

function compileStandard(schema: StandardSchemaV1): SchemaValidator<unknown> {
  return input => {
    const result = schema['~standard'].validate(input)
    return result instanceof Promise ? result.then(firstStandardIssue) : firstStandardIssue(result)
  }
}

/** As TypeBox's, a library's failure is reported by its first issue, however many it collected. */
function firstStandardIssue(result: StandardSchemaV1.Result<unknown>): SchemaValidationResult<unknown> {
  const validated = standardResult(result)
  return validated.ok ? validated : { ok: false, issues: validated.issues.slice(0, 1) }
}

/**
 * Clone so the caller's input is never mutated, then optionally create the declared object nodes it omits, fill
 * defaults, coerce (`'8080'` becomes `8080`, which is the only way environment variables can satisfy a typed
 * schema), drop undeclared keys, and check.
 *
 * `Value.Clean` is what makes unknown keys *dropped rather than rejected*, matching how object schemas behave in
 * zod and valibot. Without it a single unrelated environment variable would fail startup.
 */
function validateTypeBox(
  schema: TSchema,
  input: unknown,
  options: SchemaValidateOptions,
): SchemaValidationResult<unknown> {
  let value = Value.Clone(input)
  if (options.materialize === true) {
    value = materializeObjects(schema, value)
  }
  value = Value.Default(schema, value)
  value = Value.Convert(schema, value)
  value = Value.Clean(schema, value)

  if (Value.Check(schema, value)) {
    return options.decode === true ? decodeCodecs(schema, value) : { ok: true, value }
  }

  return { ok: false, issues: [...Value.Errors(schema, value)].map(errorIssue) }
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

  return standardResult(result)
}

function standardResult(result: StandardSchemaV1.Result<unknown>): SchemaValidationResult<unknown> {
  if (result.issues) {
    return { ok: false, issues: result.issues.map(toSchemaIssue) }
  }

  return { ok: true, value: result.value }
}

function toSchemaIssue(issue: StandardSchemaV1.Issue): SchemaIssue {
  const path = (issue.path ?? []).map(segment => String(typeof segment === 'object' ? segment.key : segment)).join('.')

  return { path, message: issue.message }
}

function errorIssue(error: ValueError): SchemaIssue {
  return { path: pointerToDotted(error.path), message: error.message, code: String(error.type) }
}

/** TypeBox reports a JSON Pointer (`/server/port`); the rest of Caffeine speaks dotted paths (`server.port`). */
function pointerToDotted(pointer: string): string {
  return pointer.replace(/^\//, '').replaceAll('/', '.')
}

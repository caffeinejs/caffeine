import { FormatRegistry, type TSchema } from '@sinclair/typebox'
import { TypeCompiler } from '@sinclair/typebox/compiler'
import type { ValueError } from '@sinclair/typebox/errors'
import { HasTransform, TransformDecode, TransformDecodeError, TransformEncode, Value } from '@sinclair/typebox/value'
import type { StandardSchemaV1 } from '@standard-schema/spec'

import { compileAdditional, type CompiledIssue, type CompiledResult } from './_additional.js'
import { keywordOf } from './_keywords.js'
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
 * A TypeBox schema runs the pipeline below, checking a `format` by what {@link registerFormat} registered under its
 * name: one nobody registered refuses every value. A Standard Schema runs its own library's validator, so refinements
 * and transforms behave exactly as the author wrote them.
 */
export function validateSchema<S extends AnySchema>(
  schema: S,
  input: unknown,
  options: SchemaValidateOptions = {},
): SchemaValidationResult<InferSchema<S>> {
  if (isTypeBoxSchema(schema)) {
    return validateTypeBox(schema, input, options) as SchemaValidationResult<InferSchema<S>>
  }
  return validateStandard(schema as StandardSchemaV1, input) as SchemaValidationResult<InferSchema<S>>
}

/**
 * A Standard Schema that validates one value against `schema`, to run on many values: whatever depends on the schema
 * alone is done here, once.
 *
 * A TypeBox schema is compiled to code, and each value is then handled in turn. Its declared defaults are filled in.
 * Its types are converted: `'8080'` becomes `8080`, `'a'` becomes `['a']` where an array is declared, and `'1.9'` and
 * `1.9` become `1` where an integer is. A key an object does not declare is dropped where it says
 * `additionalProperties: false`, a nullable object included; a key a `patternProperties` pattern matches stays, and is
 * converted and checked against that pattern's schema but never decoded. Inside another union or an intersection
 * nothing is dropped, and a `$t.Object` is checked as TypeBox checks it alone: a key only one of its patterns allows
 * counts as undeclared. The value is then checked, a `format` by what {@link registerFormat} registered under its name,
 * and its codecs decoded. A failure reports its first issue only, so the report on a large invalid value is no larger
 * than on a small one; the issue carries `code`, the JSON Schema keyword the value broke (`minLength`, `required`), or
 * `decode` for a codec that refused it.
 *
 * The value is worked on in place, not copied: hand it one nobody else holds, such as a request's parsed body.
 *
 * A Standard Schema is returned as it is: its own library validates.
 *
 * @throws TypeCompilerUnknownTypeError when the TypeBox schema holds a kind TypeBox cannot check, such as
 * `$t.Unsafe(...)`.
 * @throws TypeCompilerTypeGuardError when TypeBox refuses the schema, such as a `pattern` that is not a regular
 * expression.
 * @throws SyntaxError when a `patternProperties` key is not a regular expression.
 */
export function compileValidator<S extends AnySchema>(schema: S): StandardSchemaV1<unknown, InferSchema<S>> {
  if (!isTypeBoxSchema(schema)) {
    return schema as StandardSchemaV1<unknown, InferSchema<S>>
  }

  const validate = compileTypeBox(schema, true)
  return {
    '~standard': {
      version: 1,
      vendor: 'caffeine',
      validate: input => {
        const result = validate(input)
        return result.ok ? { value: result.value as InferSchema<S> } : { issues: [standardIssue(result.issue)] }
      },
    },
  }
}

/**
 * Teaches the TypeBox validators a string format, so a schema's `format: name` is checked with `check`.
 *
 * Replaces a check already registered under `name`, the one `@caffeinejs/http` registers included. TypeBox refuses
 * every value of a format it does not know, so a schema naming one fails all input until it is registered.
 */
export function registerFormat(name: string, check: (value: string) => boolean): void {
  FormatRegistry.Set(name, check)
}

/** Whether a check is registered for the string format `name`. */
export function hasFormat(name: string): boolean {
  return FormatRegistry.Has(name)
}

/**
 * Whether a schema holds a codec, such as `$t.Duration()` or `$t.List()`: a TypeBox transform, which checking a value
 * against the schema's JSON Schema leaves undecoded. A Standard Schema answers `false`; its own validator runs
 * whatever it transforms.
 */
function hasCodec(schema: AnySchema): boolean {
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

function compileTypeBox(authored: TSchema, decode: boolean): (input: unknown) => CompiledResult {
  // The keys an object does not declare, which TypeBox cannot check as Ajv does, are handled apart; TypeBox gets the
  // rest. Nothing under a key `decode` leaves undecoded is decoded either.
  const additional = compileAdditional(authored, (child, decodeChild) => compileTypeBox(child, decode && decodeChild))
  const schema = additional.schema
  const checker = TypeCompiler.Compile(schema)
  const decodes = decode && HasTransform(schema, [])
  // Filling defaults walks the value without compiled code: a schema that declares none skips it.
  const defaults = hasDefault(schema)

  return input => {
    let value = defaults ? Value.Default(schema, input) : input
    value = Value.Convert(schema, value)

    const issue = additional.apply(value)
    if (issue !== undefined) {
      return { ok: false, issue }
    }

    if (!checker.Check(value)) {
      // A value `Check` refuses has at least one error; only the first is read.
      const [error] = checker.Errors(value)
      return { ok: false, issue: compiledIssue(error) }
    }

    if (!decodes) {
      return { ok: true, value }
    }

    try {
      // Checked just above, so `TransformDecode` skips the check `Value.Decode` would run again.
      return { ok: true, value: TransformDecode(schema, [], value) }
    } catch (error) {
      return { ok: false, issue: compiledDecodeIssue(error) }
    }
  }
}

// Whether a `default` is declared anywhere in `node`.
function hasDefault(node: unknown): boolean {
  if (Array.isArray(node)) {
    return node.some(hasDefault)
  }
  if (typeof node !== 'object' || node === null) {
    return false
  }
  return Object.hasOwn(node, 'default') || Object.values(node).some(hasDefault)
}

// A Standard Schema issue leaves its path out at the root.
function standardIssue(issue: CompiledIssue): StandardSchemaV1.Issue & { readonly code: string } {
  return issue.path.length === 0 ? { message: issue.message, code: issue.code } : issue
}

function compiledIssue(error: ValueError): CompiledIssue {
  return { message: error.message, path: pointerSegments(error.path), code: keywordOf(error.type) }
}

function compiledDecodeIssue(error: unknown): CompiledIssue {
  if (error instanceof TransformDecodeError) {
    return { message: error.error.message, path: pointerSegments(error.path), code: 'decode' }
  }

  return { message: error instanceof Error ? error.message : String(error), path: [], code: 'decode' }
}

// RFC 6901: `~1` before `~0`, so `~01` reads as `~1` and not as `/`.
function pointerSegments(pointer: string): string[] {
  return pointer === ''
    ? []
    : pointer
        .slice(1)
        .split('/')
        .map(segment => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
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

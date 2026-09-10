import {
  type SchemaOptions,
  type Static,
  type TLiteral,
  type TLiteralValue,
  type TSchema,
  type TString,
  type TTransform,
  type TUnion,
  Type,
  JavaScriptTypeBuilder,
} from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'

import { DURATION_PATTERN, parseDuration } from '../duration/index.js'
import { DEFAULT_LIST_SEPARATOR, textList } from './text.js'

type LiteralsOf<T extends readonly TLiteralValue[]> = {
  -readonly [K in keyof T]: TLiteral<T[K] & TLiteralValue>
}

/** The annotation {@link caffeineT.Secret} stamps, and {@link isSecretSchema} reads back. */
export const SECRET_KEYWORD = 'x-caffeine-secret'

/** Whether a schema node was marked with {@link caffeineT.Secret}. */
export function isSecretSchema(schema: unknown): boolean {
  return typeof schema === 'object' && schema !== null && (schema as Record<string, unknown>)[SECRET_KEYWORD] === true
}

/**
 * Whether a schema node is an uploaded file — `{@link caffeineT.File}` or the items of
 * {@link caffeineT.Files}.
 */
export function isFileSchema(schema: unknown): boolean {
  return typeof schema === 'object' && schema !== null && (schema as Record<string, unknown>).format === 'binary'
}

/**
 * Whether a schema describes an upload: a file, an array of files, or an object with a file among its
 * properties.
 *
 * This is what tells a route apart as a `multipart/form-data` upload — HTTP leaves such a body slot
 * unvalidated because its parts are streamed rather than parsed, and OpenAPI documents it as multipart.
 */
export function hasFileSchema(schema: unknown): boolean {
  if (isFileSchema(schema)) {
    return true
  }

  if (typeof schema !== 'object' || schema === null) {
    return false
  }

  const { items, properties } = schema as { items?: unknown; properties?: unknown }

  if (isFileSchema(items)) {
    return true
  }

  if (typeof properties !== 'object' || properties === null) {
    return false
  }

  return Object.values(properties).some(
    property => isFileSchema(property) || isFileSchema((property as { items?: unknown }).items),
  )
}

/** Options for {@link caffeineT.List}. */
export interface ListOptions extends SchemaOptions {
  /** The delimiter between elements. Default `,`. */
  separator?: string
  /** Replaces the delimiter split entirely, for an encoding that is not delimited at all. */
  parse?: (raw: string) => unknown
}

/**
 * A codec accepts either the text encoding or the value already decoded, so the same schema serves a value from
 * an environment variable and one from a file or the code band.
 */
type Codec<T extends TSchema> = TTransform<TUnion<[TSchema, T]>, Static<T>>

const caffeineT = {
  /**
   * A union of literals, written as a list of values rather than `$t.Union([$t.Literal('A'), $t.Literal('B')])`.
   *
   * This is sugar: it still emits a TypeBox `anyOf` of consts, so TypeBox's `Value` can check it. HTTP compilation
   * later collapses that shape into a single `enum` keyword for Ajv. A custom TypeBox Kind would make `Value.Check`
   * throw `Unknown type` on a configuration schema, so there is none.
   *
   * `TLiteralValue` is `boolean | number | string`. For `null`, wrap with `$t.Nullable`:
   * `$t.Nullable($t.UnionEnum(['A', 'B']))`.
   */
  UnionEnum: <const T extends readonly TLiteralValue[]>(values: T, options?: SchemaOptions): TUnion<LiteralsOf<T>> =>
    Type.Union(values.map(value => Type.Literal(value)) as LiteralsOf<T>, options) as TUnion<LiteralsOf<T>>,

  /**
   * The value, or `null`.
   *
   * Emitted as an `anyOf` union rather than the OpenAPI 3.0 `nullable: true` keyword: `nullable` is not JSON
   * Schema, and Ajv in strict mode rejects keywords it does not know.
   */
  Nullable: <T extends TSchema>(schema: T, options?: SchemaOptions) => Type.Union([schema, Type.Null()], options),

  /**
   * The value, or `null`, or absent altogether.
   *
   * Absence is expressed the JSON Schema way — the property is left out of `required` — not by adding `undefined`
   * to the union. There is no `undefined` in JSON Schema, and a schema claiming otherwise is rejected outright by
   * Ajv, so a union of that shape would fail every route it was attached to.
   */
  MaybeEmpty: <T extends TSchema>(schema: T, options?: SchemaOptions) =>
    Type.Optional(Type.Union([schema, Type.Null()], options)),

  /**
   * A list that may be written as delimited text — `TAGS=a,b,c` — as well as as an array.
   *
   * Declaring the encoding is the whole point. Coercing wherever a schema merely happens to say `array` would
   * coerce on type rather than on intent, splitting a string from a YAML file that was always meant to be one
   * string. Here nothing is guessed: a field is a text list because it says so.
   *
   * It is also the only way to *shorten* or clear a list from a higher-priority source. The indexed spelling
   * (`TAGS__0`, `TAGS__1`) still works and is untouched, but it cannot express an empty list, and overriding a
   * three-element list with a two-element one leaves the third behind.
   *
   * ```ts
   * $t.Object({
   *   tags:  $t.List($t.String()),                     // TAGS=a,b,c
   *   hosts: $t.List($t.String(), { separator: ';' }),  // HOSTS=a;b;c
   *   ports: $t.List($t.Number(), { parse: myParser }), // any other encoding
   * })
   * ```
   *
   * JSON is deliberately not recognized here — `$t.JSON($t.Array(...))` is that, and a helper that guessed
   * between the two could not be given an honest name.
   */
  List: <T extends TSchema>(items: T, options: ListOptions = {}): Codec<ReturnType<typeof Type.Array<T>>> => {
    const { separator = DEFAULT_LIST_SEPARATOR, parse, ...schemaOptions } = options
    const target = Type.Array(items)

    return Type.Transform(Type.Union([Type.String(), target], schemaOptions))
      .Decode(value =>
        decodeInto(target, value, {
          // Delimited text carries no types of its own, so the elements are converted the way every other value
          // from an environment variable is: `$t.List($t.Number())` must yield numbers, not numeric strings.
          convert: true,
          parse: raw => (parse === undefined ? textList(raw, separator) : parse(raw)),
          complaint: 'is not a list of the declared item type',
        }),
      )
      .Encode(value => value) as never
  },

  /**
   * Marks a field as a secret, so configuration diagnostics report it as `[redacted]` rather than printing it.
   *
   * A secret belongs in the configuration tree — that is how `AUTH__SCHEMES__JWT__SECRET` reaches the feature
   * that needs it, and keeping it out would mean the caller reading the environment by hand again. What must
   * not happen is the same value coming back out of `Configuration.diagnostics`, which exists to be dumped.
   *
   * ```ts
   * $t.Object({
   *   issuer: $t.String(),
   *   secret: $t.Secret($t.String()),
   * })
   * ```
   *
   * **This is a disclosure boundary, not secret management.** The value is in memory, in whatever source
   * supplied it, and readable by whatever holds the slice. All this stops is the framework's own diagnostics
   * handing it to a log.
   *
   * Implemented as a plain annotation rather than a TypeBox `Kind`: an unknown keyword rides along untouched,
   * whereas a custom Kind makes `Value.Check` throw `Unknown type` on the schema — the same trap
   * {@link caffeineT.UnionEnum} documents.
   */
  Secret: <T extends TSchema>(schema: T, options?: SchemaOptions): T =>
    ({ ...schema, ...options, [SECRET_KEYWORD]: true }) as T,

  /**
   * An uploaded file, in the body of a `multipart/form-data` route.
   *
   * ```ts
   * .schema({ body: $t.Object({ avatar: $t.File(), caption: $t.String() }) })
   * ```
   *
   * Declaring the upload is what documents it: `{ type: 'string', format: 'binary' }` is how JSON Schema and
   * OpenAPI spell a file, and a consumer reading the document renders a file picker rather than a text box.
   *
   * **The declaration does not parse the request.** A body holding a file is left unvalidated and
   * `ctx.req.body()` stays empty, because the parts are streamed rather than buffered; read them with
   * `multipart(ctx)` from `@caffeinejs/multipart`. The other slots — `params`, `querystring`, `headers` —
   * still validate.
   */
  File: (options: SchemaOptions = {}) => Type.Unsafe<File>({ ...options, type: 'string', format: 'binary' }),

  /** Several uploaded files sent under one field name. See {@link caffeineT.File}. */
  Files: (options: SchemaOptions = {}) =>
    Type.Unsafe<File[]>({ ...options, type: 'array', items: { type: 'string', format: 'binary' } }),

  /**
   * A value that may be written as JSON text — `DB={"host":"h","port":5432}` — as well as as itself.
   *
   * `inner` can be anything: an object, an array of objects, a union, even a scalar. That generality is why
   * there is no custom parser here; a parser would make the name a lie, and {@link caffeineT.List} already
   * covers the encoding that is not JSON.
   *
   * ```ts
   * $t.Object({
   *   db:    $t.JSON($t.Object({ host: $t.String(), port: $t.Number() })),
   *   rules: $t.JSON($t.Array($t.Object({ id: $t.Number() }))),
   * })
   * ```
   */
  JSON: <T extends TSchema>(inner: T, options: SchemaOptions = {}): Codec<T> =>
    Type.Transform(Type.Union([Type.String(), inner], options))
      .Decode(value =>
        decodeInto(inner, value, {
          // JSON carries its own types, so nothing is coerced: `{"host":123}` against a string field is a
          // mistake worth reporting, not something to quietly turn into `"123"`.
          convert: false,
          parse: raw => JSON.parse(raw) as unknown,
          complaint: 'is not the declared shape',
        }),
      )
      .Encode(value => JSON.stringify(value)) as never,

  /**
   * A time span written as duration text — `'5s'`, `'1h30m'`, `'300ms'` — decoded to whole milliseconds.
   *
   * The value is checked against {@link DURATION_PATTERN} first, so `'5 hours'` fails configuration validation
   * rather than being read as `0`. Only the string form is accepted; a bare number is rejected, because its unit
   * would be ambiguous.
   *
   * The decoded number needs no re-check the way {@link caffeineT.List} and {@link caffeineT.JSON} do: the pattern
   * has already constrained the input and {@link parseDuration} maps every such string to a finite number.
   */
  Duration: (options: SchemaOptions = {}): TTransform<TString, number> =>
    Type.Transform(Type.String({ ...options, pattern: DURATION_PATTERN }))
      .Decode(text => Math.round(parseDuration(text) * 1000))
      .Encode(ms => `${ms}ms`) as never,
}

/**
 * Decodes the text form and checks the result against the schema it claims to be.
 *
 * The check is not optional. TypeBox validates a transform's *encoded* form and never re-examines what `Decode`
 * returned, so without this `DB={"host":123}` would sail through as a valid object with a number where a string
 * was declared. Doing it here rather than in a second pass afterwards also keeps each codec self-contained:
 * nothing downstream has to go looking for transforms to finish their job.
 *
 * A value that did not arrive as text is passed through untouched — it came from a file or the code band and
 * the surrounding schema already governs it.
 */
function decodeInto<T extends TSchema>(
  target: T,
  value: unknown,
  how: { convert: boolean; parse: (raw: string) => unknown; complaint: string },
): Static<T> {
  if (typeof value !== 'string') {
    return value as Static<T>
  }

  const parsed = how.parse(value)
  const decoded = how.convert ? Value.Convert(target, parsed) : parsed

  if (!Value.Check(target, decoded)) {
    throw new Error(`The value ${how.complaint}`)
  }

  return decoded as Static<T>
}

const $t = Object.assign({}, Type, caffeineT) as JavaScriptTypeBuilder & typeof caffeineT

export { $t }

import {
  type SchemaOptions,
  type TLiteral,
  type TLiteralValue,
  type TSchema,
  type TUnion,
  Type,
  JavaScriptTypeBuilder,
} from '@sinclair/typebox'

type LiteralsOf<T extends readonly TLiteralValue[]> = {
  -readonly [K in keyof T]: TLiteral<T[K] & TLiteralValue>
}

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
  UnionEnum: <const T extends readonly TLiteralValue[]>(
    values: T,
    options?: SchemaOptions,
  ): TUnion<LiteralsOf<T>> =>
    Type.Union(values.map(value => Type.Literal(value)) as LiteralsOf<T>, options) as TUnion<LiteralsOf<T>>,

  /**
   * The value, or `null`.
   *
   * Emitted as an `anyOf` union rather than the OpenAPI 3.0 `nullable: true` keyword: `nullable` is not JSON
   * Schema, and Ajv in strict mode rejects keywords it does not know.
   */
  Nullable: <T extends TSchema>(schema: T, options?: SchemaOptions) =>
    Type.Union([schema, Type.Null()], options),

  /**
   * The value, or `null`, or absent altogether.
   *
   * Absence is expressed the JSON Schema way — the property is left out of `required` — not by adding `undefined`
   * to the union. There is no `undefined` in JSON Schema, and a schema claiming otherwise is rejected outright by
   * Ajv, so a union of that shape would fail every route it was attached to.
   */
  MaybeEmpty: <T extends TSchema>(schema: T, options?: SchemaOptions) =>
    Type.Optional(Type.Union([schema, Type.Null()], options)),
}

const $t = Object.assign({}, Type, caffeineT) as JavaScriptTypeBuilder & typeof caffeineT

export { $t }

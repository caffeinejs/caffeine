import type { Static, TSchema } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { ConfigSchema } from '../schema.js'

/**
 * Wraps a TypeBox schema as a {@link ConfigSchema}. TypeBox is not Standard-Schema-native, so this adapter
 * bridges it: on validation it applies defaults, coerces strings to the declared types (ideal for environment
 * values), then checks — mapping any failures to Standard Schema issues. Use it when you prefer TypeBox:
 *
 * ```ts
 * import { Type } from '@sinclair/typebox'
 * import { typebox } from '@caffeinejs/std/config/typebox'
 *
 * app.config(typebox(Type.Object({ server: Type.Object({
 *   host: Type.String({ default: '0.0.0.0' }),
 *   port: Type.Number({ default: 9999 }),
 * }) })))
 * ```
 */
export function typebox<T extends TSchema>(schema: T): ConfigSchema<Static<T>> {
  return {
    '~standard': {
      version: 1,
      vendor: 'typebox',
      validate(input: unknown): StandardSchemaV1.Result<Static<T>> {
        const value = Value.Convert(schema, Value.Default(schema, Value.Clone(input)))

        if (Value.Check(schema, value)) {
          return { value: value as Static<T> }
        }

        const issues: StandardSchemaV1.Issue[] = [...Value.Errors(schema, value)].map(error => ({
          message: error.message,
          path: error.path.split('/').filter(Boolean),
        }))
        return { issues }
      },
    },
  }
}

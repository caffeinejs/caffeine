import { compileEncoder, compileValidator, toJSONSchema } from '@caffeinejs/application/schema'
import { errMessage } from '@caffeinejs/std/err'
import build, { type Schema } from 'fast-json-stringify'

import { ErrConfiguration } from '../error/common.js'
import { registerDefaultFormats } from './_formats.js'
import { normalizeForAjv } from './normalize.js'
import type { SchemaCompiler } from './validation.js'

registerDefaultFormats()

/**
 * The default {@link SchemaCompiler}: TypeBox validates, and fast-json-stringify writes the responses.
 *
 * A validator reports the first issue a value breaks, its `code` the JSON Schema keyword (`minLength`, `required`).
 * TypeBox checks a `format` by what `registerFormat` from `@caffeinejs/application/schema` registered under its name;
 * loading this registers the formats Fastify's Ajv checks (`email`, `uuid`, `date-time`, …) for every name not
 * registered yet, in the registry configuration validation shares.
 */
export const typeBoxSchemaCompiler: SchemaCompiler = Object.freeze<SchemaCompiler>({
  validator({ schema, context }) {
    try {
      return compileValidator(schema)
    } catch (err) {
      throw compileError(err, context)
    }
  },

  serializer({ schema, context }) {
    let write: (value: unknown) => string
    try {
      // The same JSON Schema Fastify hands fast-json-stringify, typed apart by each package.
      write = build(normalizeForAjv(toJSONSchema(schema, 'output', context)) as unknown as Schema)
    } catch (err) {
      throw new ErrConfiguration(
        errMessage(`Cannot compile the "${context}" schema: ${err instanceof Error ? err.message : String(err)}`)
          .solutions('Declare the response with "$t" types')
          .reference('@caffeinejs/http', ErrConfiguration)
          .build(),
      )
    }

    const encode = compileEncoder(schema)
    return encode === undefined ? write : value => write(encode(value))
  },
})

function compileError(err: unknown, context: string): ErrConfiguration {
  const failed = `Cannot compile the "${context}" schema`
  const detail = err instanceof Error ? err.message : String(err)
  const message =
    err instanceof SyntaxError
      ? errMessage(`${failed}: a pattern in it is not a valid regular expression (${detail})`).solutions(
          'Write the pattern as a regular expression that reads with the "u" flag',
        )
      : errMessage(`${failed}: TypeBox cannot check it (${detail})`).solutions(
          'Declare the slot with "$t" types TypeBox checks, such as "$t.String()" in place of "$t.Unsafe(...)"',
          'Register a custom kind with TypeBox\'s "TypeRegistry.Set(...)"',
        )
  return new ErrConfiguration(message.reference('@caffeinejs/http', ErrConfiguration).build())
}

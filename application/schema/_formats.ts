import { FormatRegistry } from '@sinclair/typebox'
import { fullFormats } from 'ajv-formats/dist/formats.js'

let registered = false

// Teaches TypeBox the string formats Fastify's Ajv checks, `ajv-formats`' full set, so `format: 'email'` means the same
// whichever of the two validates a value. TypeBox refuses every value of a format it does not know, so without this a
// schema naming one fails all input.
//
// A format already registered is left as it is, whoever registered it. The number formats (`int32`, `int64`, `float`,
// `double`) are not registered: TypeBox reads `format` on a string alone. `ajv-formats` publishes the list of formats
// from this file alone; its package declares no `exports`, so the path is the one its own entry imports.
export function registerFormats(): void {
  if (registered) {
    return
  }
  registered = true

  for (const [name, format] of Object.entries(fullFormats)) {
    const check = checkOf(format)
    if (check !== undefined && !FormatRegistry.Has(name)) {
      FormatRegistry.Set(name, check)
    }
  }
}

function checkOf(format: unknown): ((value: string) => boolean) | undefined {
  // `true` marks a format Ajv only names, such as `binary` and `password`.
  if (format === true) {
    return () => true
  }
  if (format instanceof RegExp) {
    return value => format.test(value)
  }
  if (typeof format === 'function') {
    return value => (format as (value: string) => boolean)(value)
  }
  if (typeof format === 'object' && format !== null) {
    const { type, validate } = format as { type?: string; validate?: unknown }
    return type === undefined || type === 'string' ? checkOf(validate) : undefined
  }
  return undefined
}

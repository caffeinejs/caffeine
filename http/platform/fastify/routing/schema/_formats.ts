import { registerFormat } from '@caffeinejs/application/schema'
import { fullFormats } from 'ajv-formats/dist/formats.js'

let registered = false

// Teaches the validators Caffeine runs on a route the string formats Fastify's Ajv checks, `ajv-formats`' full set, so
// `format: 'email'` means the same on a route whichever of the two validates it. A format already registered under a
// name is left as it is.
//
// The number formats (`int32`, `int64`, `float`, `double`) are not registered: TypeBox reads `format` on a string
// alone. `ajv-formats` publishes the list of formats from this file alone; its package declares no `exports`, so the
// path is the one its own entry imports.
export function registerAjvFormats(): void {
  if (registered) {
    return
  }
  registered = true

  for (const [name, format] of Object.entries(fullFormats)) {
    const check = checkOf(format)
    if (check !== undefined) {
      registerFormat(name, check)
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

import { hasFormat, registerFormat } from '@caffeinejs/application/schema'
import { fullFormats } from 'ajv-formats/dist/formats.js'

type Check = (value: string) => boolean

/**
 * Registers the string formats Fastify's Ajv checks, `ajv-formats`' full set, for every name nobody registered yet: an
 * application's own `registerFormat` stays. The number formats (`int32`, `double`, …) are left out, as TypeBox checks
 * `format` on strings only.
 */
export function registerDefaultFormats(): void {
  for (const [name, format] of Object.entries(fullFormats)) {
    const check = checkOf(format)
    if (check !== undefined && !hasFormat(name)) {
      registerFormat(name, check)
    }
  }
}

function checkOf(format: unknown): Check | undefined {
  if (format === true) {
    return () => true
  }
  if (format instanceof RegExp) {
    return value => format.test(value)
  }
  if (typeof format === 'function') {
    return format as Check
  }
  if (typeof format === 'object' && format !== null) {
    const { type, validate } = format as { type?: string; validate?: unknown }
    return type === 'number' ? undefined : checkOf(validate)
  }
  return undefined
}

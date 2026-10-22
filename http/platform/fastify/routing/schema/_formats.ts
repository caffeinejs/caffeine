import { registerFormat } from '@caffeinejs/application/schema'
import type { FastifyRequest } from 'fastify'

// A `format` on a route Caffeine validates is checked by the server's own Ajv, so it means there what it means on a
// route Ajv validates, the formats and options the server configured included.
//
// TypeBox checks a format with a function of the value alone, and Fastify compiles one only from a request: the hook
// validating a request hands it over for the checks it runs, and a format is compiled from that request the first
// time one is checked, then kept for the process. TypeBox's registry is process-wide too, so with several servers the
// first to check a format compiles it for all of them. A check run outside a validated request before then refuses,
// as TypeBox refuses a format it does not know. A format Ajv does not know throws Ajv's error.

const compiled = new Map<string, (value: string) => boolean>()

let validating: FastifyRequest | undefined

// Every `format` a schema names, at any depth.
export function formatsIn(schema: unknown, found: Set<string> = new Set()): Set<string> {
  if (Array.isArray(schema)) {
    for (const item of schema) {
      formatsIn(item, found)
    }
  } else if (typeof schema === 'object' && schema !== null) {
    for (const [key, value] of Object.entries(schema)) {
      if (key === 'format' && typeof value === 'string') {
        found.add(value)
      } else {
        formatsIn(value, found)
      }
    }
  }
  return found
}

export function registerRouteFormat(name: string): void {
  registerFormat(name, value => checkFormat(name, value))
}

// Runs `run`, synchronous, with `request` the one its format checks compile from.
export function checkingFormats<T>(request: FastifyRequest, run: () => T): T {
  validating = request
  try {
    return run()
  } finally {
    validating = undefined
  }
}

function checkFormat(name: string, value: string): boolean {
  let check = compiled.get(name)
  if (check === undefined) {
    if (validating === undefined) {
      return false
    }
    const validate = validating.compileValidationSchema({ type: 'string', format: name })
    check = text => validate(text) === true
    compiled.set(name, check)
  }
  return check(value)
}

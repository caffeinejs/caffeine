import { registerFormat } from '@caffeinejs/application/schema'
import type { FastifyRequest } from 'fastify'

// A `format` on a route Caffeine validates is checked by the server's own Ajv, so it means there what it means on a
// route Ajv validates, the formats and options the server configured included.
//
// TypeBox checks a format with a function of the value alone, and Fastify compiles one only from a request: the hook
// validating a request hands it over for the checks it runs, and each check compiles its format from that request.
// Fastify keeps what it compiled in the route's own cache, keyed by the schema object, so each name keeps one schema
// and each server's Ajv answers for its own routes. A check run outside a validated request refuses, as TypeBox
// refuses a format it does not know. A format Ajv does not know throws Ajv's error.

// One schema object per format name, so Fastify's cache finds what it compiled before.
const schemas = new Map<string, { type: 'string'; format: string }>()

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
  if (validating === undefined) {
    return false
  }

  let schema = schemas.get(name)
  if (schema === undefined) {
    schema = { type: 'string', format: name }
    schemas.set(name, schema)
  }
  return validating.compileValidationSchema(schema)(value) === true
}

import { type AnySchema, type JSONSchema, toJSONSchema } from '@caffeinejs/std/schema'
import type { FastifySchema } from 'fastify'
import type { RouteValidationSchema } from '../route.js'
import { normalizeForAjv } from './_normalize.js'

/** The request slots, in the order they appear in an error message. */
const REQUEST_SLOTS = ['params', 'querystring', 'headers', 'body'] as const

/**
 * Compiles an authored {@link RouteValidationSchema} into the plain JSON Schema Fastify expects.
 *
 * Called once per route while routes are being registered, so nothing schema-related happens on the request path:
 * Fastify compiles the result into Ajv validators (and fast-json-stringify serializers) at startup, and an
 * unconvertible schema fails the process before it ever listens.
 *
 * @param context - Identifies the route in failures, e.g. `POST /pets`.
 */
export function compileRouteSchema(
  schema: RouteValidationSchema | undefined,
  context: string,
): FastifySchema | undefined {
  if (schema === undefined) {
    return undefined
  }

  const compiled: FastifySchema = {}

  for (const slot of REQUEST_SLOTS) {
    const authored = schema[slot]
    if (authored !== undefined) {
      const converted = normalizeForAjv(toJSONSchema(authored, 'input', `${context} ${slot}`))
      compiled[slot] = applySlotPolicy(converted, slot)
    }
  }

  if (schema.response !== undefined) {
    const response: Record<string, JSONSchema> = {}
    for (const [status, authored] of Object.entries(schema.response)) {
      response[status] = normalizeForAjv(
        toJSONSchema(authored as AnySchema, 'output', `${context} response.${status}`),
      )
    }
    compiled.response = response
  }

  return compiled
}

/**
 * Decides `additionalProperties` per slot, and only when the author left it open — an explicit choice is always
 * honoured.
 *
 * This matters more than it looks, because Fastify configures Ajv with `removeAdditional: true`. Undeclared
 * properties are therefore *stripped*, not rejected, wherever a schema says `additionalProperties: false`:
 *
 * - `headers` is forced open. Requests always carry headers nobody declares (`host`, `user-agent`, `content-type`),
 *   and a closed schema would delete them from `request.headers`. Correctness, not taste.
 * - `body` is closed, so fields the client invented never reach the handler. That is mass-assignment protection,
 *   and it strips silently rather than answering 400.
 * - `querystring` and `params` stay as authored. Closing the query string would quietly discard parameters read
 *   through `ctx.req.query()` or by a plugin.
 * - `response` stays as authored; fast-json-stringify emits only declared properties regardless.
 */
function applySlotPolicy(schema: JSONSchema, slot: typeof REQUEST_SLOTS[number]): JSONSchema {
  if (slot !== 'headers' && slot !== 'body') {
    return schema
  }

  if (!isObjectSchema(schema) || 'additionalProperties' in schema) {
    return schema
  }

  // A copy: the authored schema may be shared between routes and slots, and must not be rewritten in place.
  return { ...schema, additionalProperties: slot === 'headers' }
}

function isObjectSchema(schema: JSONSchema): boolean {
  return schema.type === 'object' && typeof schema.properties === 'object'
}

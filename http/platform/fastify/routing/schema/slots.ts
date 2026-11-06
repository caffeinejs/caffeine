import type { RouteValidationSchema } from '../../../../core/routing/spec.js'

/** A request slot of a route schema. */
export type RequestSlot = Exclude<keyof RouteValidationSchema, 'response'>

/** The request slots, in the order Fastify validates them. */
export const REQUEST_SLOTS: readonly RequestSlot[] = ['params', 'body', 'querystring', 'headers']

/**
 * Decides `additionalProperties` per slot, and only when the author left it open — an explicit choice is always
 * honoured.
 *
 * This matters more than it looks, because Fastify configures Ajv with `removeAdditional: true`, and Caffeine's own
 * validation does the same. Undeclared properties are therefore *stripped*, not rejected, wherever a schema says
 * `additionalProperties: false`:
 *
 * - `headers` is forced open. Requests always carry headers nobody declares (`host`, `user-agent`, `content-type`),
 *   and a closed schema would delete them from `request.headers`. Correctness, not taste.
 * - `body` is closed, so fields the client invented never reach the handler. That is mass-assignment protection,
 *   and it strips silently rather than answering 400.
 * - `querystring` and `params` stay as authored. Closing the query string would quietly discard parameters read
 *   through `ctx.req.query()` or by a plugin.
 * - `response` stays as authored; fast-json-stringify emits only declared properties regardless.
 *
 * It applies to the JSON Schema handed to Ajv and to the TypeBox schema Caffeine validates with alike.
 */
export function applySlotPolicy<S extends object>(schema: S, slot: RequestSlot): S {
  if (slot !== 'headers' && slot !== 'body') {
    return schema
  }

  if (!isObjectSchema(schema) || 'additionalProperties' in schema) {
    return schema
  }

  // A copy: the authored schema may be shared between routes and slots, and must not be rewritten in place. Spread
  // keeps a TypeBox schema's kind symbols.
  return { ...schema, additionalProperties: slot === 'headers' }
}

function isObjectSchema(schema: object): boolean {
  const { type, properties } = schema as { type?: unknown; properties?: unknown }
  return type === 'object' && typeof properties === 'object'
}

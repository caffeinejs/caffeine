import type { ValidationSlot } from '../error/validation.js'

/** What a schema may say about the names of the headers it checks. */
interface HeadersSchema {
  [key: string]: unknown
  properties?: Record<string, unknown>
  required?: string[]
  allOf?: HeadersSchema[]
  anyOf?: HeadersSchema[]
  oneOf?: HeadersSchema[]
  not?: HeadersSchema
}

/**
 * Decides `additionalProperties` per slot, and only when the author left it open — an explicit choice is always
 * honoured.
 *
 * This matters more than it looks, because every validator drops a key an object does not declare where it says
 * `additionalProperties: false`, as Fastify's Ajv does with `removeAdditional: true`. Undeclared properties are
 * therefore *stripped*, not rejected:
 *
 * - `headers` is forced open. Requests always carry headers nobody declares (`host`, `user-agent`, `content-type`),
 *   and a closed schema would delete them from `request.headers`. Correctness, not taste.
 * - `body` is closed, so fields the client invented never reach the handler. That is mass-assignment protection,
 *   and it strips silently rather than answering 422.
 * - `querystring` and `params` stay as authored. Closing the query string would quietly discard parameters read
 *   through `ctx.req.query()` or by a plugin.
 *
 * A copy is returned, never the schema rewritten in place: it may be shared between routes and slots. Spread keeps a
 * TypeBox schema's kind symbols, which its compiler reads.
 */
export function applySlotPolicy<S extends object>(schema: S, slot: ValidationSlot): S {
  if (slot !== 'headers' && slot !== 'body') {
    return schema
  }

  if (!isObjectSchema(schema) || 'additionalProperties' in schema) {
    return schema
  }

  return { ...schema, additionalProperties: slot === 'headers' }
}

/**
 * A copy of a headers schema with every header name it declares lower-cased, so `Authorization` matches the
 * `authorization` key a request's headers are read under. The names are those checked against the headers
 * themselves: an object's, and those of each member of an intersection, a union or a negation.
 */
export function lowerCaseHeaders<S extends object>(schema: S): S {
  const source = schema as HeadersSchema
  // Spread keeps a TypeBox schema's kind symbols, which its compiler reads.
  const copy: HeadersSchema = { ...source }

  if (source.properties !== undefined) {
    copy.properties = Object.fromEntries(
      Object.entries(source.properties).map(([name, property]) => [name.toLowerCase(), property]),
    )
  }
  if (source.required !== undefined) {
    copy.required = source.required.map(name => name.toLowerCase())
  }
  for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
    const members = source[key]
    if (members !== undefined) {
      copy[key] = members.map(lowerCaseHeaders)
    }
  }
  if (source.not !== undefined) {
    copy.not = lowerCaseHeaders(source.not)
  }

  return copy as S
}

function isObjectSchema(schema: object): boolean {
  const { type, properties } = schema as { type?: unknown; properties?: unknown }
  return type === 'object' && typeof properties === 'object'
}

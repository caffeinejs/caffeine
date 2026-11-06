import { type AnySchema, type JSONSchema, hasFileSchema, toJSONSchema } from '@caffeinejs/application/schema'
import type { FastifySchema } from 'fastify'

import type { RouteValidationSchema } from '../../../../core/routing/spec.js'
import { normalizeForAjv } from './_normalize.js'
import { applySlotPolicy, REQUEST_SLOTS } from './slots.js'
import { validatesRequest } from './validation.js'

/**
 * Compiles an authored {@link RouteValidationSchema} into the plain JSON Schema Fastify expects.
 *
 * Called once per route while routes are being registered: Fastify compiles the result into Ajv validators (and
 * fast-json-stringify serializers) at startup, and an unconvertible schema fails the process before it ever listens.
 *
 * A route whose request Caffeine validates itself ({@link validatesRequest}) hands Fastify none of its request slots,
 * only its responses.
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

  const requestSlots = validatesRequest(schema) ? [] : REQUEST_SLOTS

  for (const slot of requestSlots) {
    const authored = schema[slot]
    if (authored !== undefined) {
      // A file body is streamed, not parsed: `request.body` is never populated, so a validator built from it
      // would answer 400 to every valid upload. The slot is documentation for OpenAPI, not a validator.
      if (slot === 'body' && hasFileSchema(authored)) {
        continue
      }

      const converted = normalizeForAjv(toJSONSchema(authored, 'input', `${context} ${slot}`))
      compiled[slot] = applySlotPolicy(converted, slot)
    }
  }

  if (schema.response !== undefined) {
    const response: Record<string, JSONSchema> = {}
    for (const [status, authored] of Object.entries(schema.response)) {
      response[status] = normalizeForAjv(toJSONSchema(authored as AnySchema, 'output', `${context} response.${status}`))
    }
    compiled.response = response
  }

  return compiled
}

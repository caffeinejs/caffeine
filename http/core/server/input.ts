import { type AnySchema, hasFileSchema, isStandardSchema, isTypeBoxSchema } from '@caffeinejs/application/schema'
import type { ByteSize } from '@caffeinejs/std/bytes'
import type { StandardSchemaV1 } from '@standard-schema/spec'

import { ErrHTTPBadRequest, ErrHTTPUnsupportedMediaType } from '../error/http.js'
import { ErrRequestValidation, type ValidationSlot } from '../error/validation.js'
import { andThen, isThenable } from '../lifecycle/lifecycle.js'
import type { IRoute } from '../routing/route.js'
import type { BodyMode } from '../routing/spec.js'
import { applySlotPolicy, lowerCaseHeaders } from '../validation/slots.js'
import { BODY_METHODS, isBodyLimit, parseBody, parsedMediaType } from './body.js'
import type { Context } from './context.js'
import { configurationError } from './error.js'
import type { ResolvedServerSettings } from './settings.js'

/** The slots in the order a request is validated: Fastify's. */
const VALIDATION_SLOTS: readonly ValidationSlot[] = ['params', 'body', 'querystring', 'headers']

/** What one route reads of its request, compiled once while it registers. */
export interface RouteInput {
  /** How the body is read: `parse` by its Content-Type, or as the route's `bodyAs` says. */
  readonly body: 'parse' | BodyMode
  /** The route's `bodyLimit`, else the server's. */
  readonly limit: ByteSize
  /** Each slot to validate, in validation order: params, body, querystring, headers. */
  readonly validators: readonly (readonly [ValidationSlot, StandardSchemaV1])[]
  /** The route in failures, e.g. `POST /pets`. */
  readonly route: string
}

/**
 * Compiles what `route` reads of its request: how its body is read, the limit it is held to, and a validator for each
 * slot its schema declares.
 *
 * @param name - The route in failures, e.g. `POST /pets`.
 *
 * @throws ErrConfiguration for a `bodyLimit` that is not a whole number of bytes above 0, a body schema on a method
 *   that carries no body or on a route that reads its body with `@BodyAsBuffer` or `@BodyAsStream`, a slot that is
 *   neither a TypeBox schema nor a Standard Schema, or one the server's schema compiler refuses.
 */
export function compileRouteInput(route: IRoute<Context>, name: string, settings: ResolvedServerSettings): RouteInput {
  if (route.bodyLimit !== undefined && !isBodyLimit(route.bodyLimit)) {
    throw configurationError(
      `Cannot serve "${name}": a bodyLimit of "${String(route.bodyLimit)}" is not a whole number of bytes above 0`,
      'Write a size in bytes, such as 1 * MiB',
    )
  }

  const validators: (readonly [ValidationSlot, StandardSchemaV1])[] = []

  for (const slot of VALIDATION_SLOTS) {
    const authored = route.schema?.[slot]
    if (authored === undefined) {
      continue
    }

    // A file body documents an upload for OpenAPI: it is never parsed, so it is never validated.
    if (slot === 'body' && hasFileSchema(authored)) {
      continue
    }

    // A GET or HEAD body is never read, so a schema for it would refuse every request, as Fastify refuses it.
    const bodiless = slot === 'body' ? route.method.find(method => !BODY_METHODS.has(method.toUpperCase())) : undefined
    if (bodiless !== undefined) {
      throw configurationError(
        `Cannot serve "${name}": its body schema needs a body, and its method ${bodiless.toUpperCase()} carries no body`,
        'Declare the body on a POST, PUT, PATCH, DELETE, OPTIONS or QUERY route',
        'Read what a GET sends from its query string or its path parameters',
      )
    }

    if (slot === 'body' && route.bodyAs !== undefined) {
      throw configurationError(
        `Cannot serve "${name}": its body schema needs a parsed body, and the route reads its body with @BodyAsBuffer or @BodyAsStream`,
        'Remove the body schema',
        'Declare it with $t.File() to document the upload',
      )
    }

    validators.push([slot, slotValidator(authored, slot, name, settings)])
  }

  return { body: route.bodyAs ?? 'parse', limit: route.bodyLimit ?? settings.bodyLimit, validators, route: name }
}

/**
 * Reads the body of a request whose method carries one, then validates each slot, writing what validation produced
 * back onto the request. A promise only when the body or a validator is asynchronous.
 *
 * @throws ErrHTTPBadRequest, ErrHTTPUnsupportedMediaType, ErrHTTPContentTooLarge, ErrRequestBodyConsumed for a body
 *   that cannot be read, and ErrRequestValidation for a slot that fails its schema; a promise rejects with the same.
 */
export function readInput(ctx: Context, input: RouteInput): void | PromiseLike<void> {
  const read = BODY_METHODS.has(ctx.req.method) ? readBody(ctx, input) : undefined

  return andThen(read, () => validate(ctx, input, 0))
}

function slotValidator(
  authored: AnySchema,
  slot: ValidationSlot,
  name: string,
  settings: ResolvedServerSettings,
): StandardSchemaV1 {
  if (isStandardSchema(authored)) {
    return authored
  }

  if (!isTypeBoxSchema(authored)) {
    throw configurationError(
      `Cannot serve "${name}": its ${slot} schema is neither a TypeBox schema nor a Standard Schema`,
      'Declare it with $t, or with a Standard Schema library such as Zod',
    )
  }

  const schema = applySlotPolicy(slot === 'headers' ? lowerCaseHeaders(authored) : authored, slot)
  return settings.schemaCompiler.validator({ schema, context: `${name} ${slot}` })
}

// As Fastify reads it: no `Content-Type` and no body is no body; a `Content-Type` decides the parser before a byte is
// read.
function readBody(ctx: Context, input: RouteInput): void | Promise<void> {
  const req = ctx.req
  const type = req.header('content-type')

  if (type === undefined) {
    if (req.method === 'QUERY') {
      throw new ErrHTTPBadRequest('A QUERY request must carry a Content-Type')
    }
    if (!req.hasBody()) {
      return
    }
    if (input.body === 'parse') {
      throw new ErrHTTPUnsupportedMediaType('The request has a body but no Content-Type')
    }
  }

  switch (input.body) {
    case 'stream':
      req.setSlot('body', req.bodyStream())
      return
    case 'buffer':
      return req.readBodyBytes().then(bytes => req.setSlot('body', bytes))
    case 'parse': {
      const parsed = parsedMediaType(type!)
      return req.readBodyBytes().then(bytes => req.setSlot('body', parseBody(parsed, bytes)))
    }
  }
}

// Each slot in turn; a validator that answers with a promise holds the rest until it settles.
function validate(ctx: Context, input: RouteInput, from: number): void | PromiseLike<void> {
  const validators = input.validators

  for (let i = from; i < validators.length; i++) {
    const [slot, schema] = validators[i]
    const result = schema['~standard'].validate(slotValue(ctx, slot))

    if (isThenable(result)) {
      return andThen(result, settled => {
        settle(ctx, input, slot, settled)
        return validate(ctx, input, i + 1)
      })
    }

    settle(ctx, input, slot, result)
  }
}

// The value a validator works on: a copy of the params, query and headers, as a validator converts in place, so a
// failure leaves them as the request carried them. The parsed body is the engine's own and is worked on in place, as
// Fastify's Ajv works on it.
function slotValue(ctx: Context, slot: ValidationSlot): unknown {
  switch (slot) {
    case 'params':
      return { ...ctx.req.param() }
    case 'querystring':
      // A plain object, which the compiled check reads fast; lookups read own names only.
      return { ...ctx.req.query() }
    case 'headers':
      return { ...ctx.req.header() }
    case 'body':
      return ctx.req.body()
  }
}

function settle(ctx: Context, input: RouteInput, slot: ValidationSlot, result: StandardSchemaV1.Result<unknown>): void {
  if (result.issues !== undefined) {
    throw new ErrRequestValidation(slot, result.issues, input.route)
  }

  ctx.req.setSlot(slot, result.value)
}

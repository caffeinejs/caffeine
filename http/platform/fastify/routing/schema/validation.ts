import {
  type AnySchema,
  compileEncoder,
  compileValidator,
  hasCodec,
  hasFileSchema,
  isStandardSchema,
  isTypeBoxSchema,
  type SchemaIssue,
  type SchemaValidationResult,
  type SchemaValidator,
} from '@caffeinejs/application/schema'
import { errMessage } from '@caffeinejs/std/err'
import type { FastifyError, FastifyRequest, FastifySchemaValidationError } from 'fastify'

import { ErrConfiguration } from '../../../../core/error/common.js'
import type { RouteValidationSchema } from '../../../../core/routing/spec.js'
import { addRouteHook, type AdapterRouteOptions } from '../route_options.js'
import { checkingFormats, formatsIn, registerRouteFormat } from './_formats.js'
import { applySlotPolicy, REQUEST_SLOTS, type RequestSlot } from './slots.js'

/** What turns validation failures into the error a route answers with, as Fastify's `schemaErrorFormatter` does. */
export type ValidationErrorFormatter = NonNullable<AdapterRouteOptions['schemaErrorFormatter']>

type ValidationError = FastifyError & Required<Pick<FastifyError, 'validation' | 'validationContext'>>

/** Where each slot's value lives on the request. */
const SLOT_PROPERTY = { params: 'params', body: 'body', querystring: 'query', headers: 'headers' } as const

interface SlotValidator {
  slot: RequestSlot
  validate: SchemaValidator<unknown>
}

/**
 * Whether Caffeine validates a route's request in place of Fastify's Ajv: one of its slots holds a codec, such as
 * `$t.Duration()`, which Ajv checks as text and never decodes, or is a Standard Schema, whose refinements and
 * transforms only its own library runs. Every request slot of such a route is then Caffeine's, so one stack validates
 * the whole request.
 *
 * A file body is left out: it is streamed, never validated.
 */
export function validatesRequest(schema: RouteValidationSchema): boolean {
  return REQUEST_SLOTS.some(slot => {
    const authored = validatedSlot(schema, slot)
    return authored !== undefined && (isStandardSchema(authored) || hasCodec(authored))
  })
}

/**
 * Validates the request of a route {@link validatesRequest} picked, in a route `preValidation` hook added after the
 * route's own, so it runs where Fastify's validation would have: every `preHandler` hook and the handler see the
 * validated, decoded values.
 *
 * It answers as Fastify does. The slots run in Fastify's order, and the first that fails ends the request with
 * Fastify's error: status 400 and code `FST_ERR_VALIDATION` unless `formatter` set its own, with `validation` and
 * `validationContext`. With `attachValidation` that error is put on `request.validationError` instead, and the request
 * goes on unvalidated. A TypeBox slot drops undeclared keys where Ajv would, under the same per-slot policy, checks a
 * `format` with the server's own Ajv, and matches its header names lower-cased, as Node delivers them. A `format` that
 * Ajv does not know fails the request that checks it with Ajv's error.
 *
 * `formatter` is the route's own or the server's; one a plugin set with `setSchemaErrorFormatter(...)` is not seen.
 *
 * @param context - Identifies the route in failures, e.g. `GET /jobs`.
 * @throws ErrConfiguration when a slot holds a schema TypeBox cannot check.
 */
export function attachRequestValidation(
  routeDef: AdapterRouteOptions,
  schema: RouteValidationSchema,
  context: string,
  formatter: ValidationErrorFormatter = formatValidationErrors,
): void {
  const validators: SlotValidator[] = []
  for (const slot of REQUEST_SLOTS) {
    const authored = validatedSlot(schema, slot)
    if (authored !== undefined) {
      validators.push({ slot, validate: slotValidator(authored, slot, `${context} ${slot}`) })
    }
  }

  addRouteHook(routeDef, 'preValidation', (request, _reply, done) => {
    validateFrom(0, request as FastifyRequest, validators, formatter, done)
  })
}

/**
 * Encodes a route's answer before Fastify serializes it, for a route whose response schemas hold a codec: the
 * `Duration` `5000` a handler returns under `$t.Duration()` goes out as `"5s"`, the text the schema declares.
 *
 * The schema is picked for the status the way Fastify picks its serializer: the exact code, then its class (`2xx`, in
 * either case), then `default`. fast-json-stringify then writes the encoded value as it would any other. A string
 * answer is sent as it is, as Fastify sends one, without reaching the hook.
 */
export function attachResponseEncoding(routeDef: AdapterRouteOptions, schema: RouteValidationSchema): void {
  // Every status with a schema, mapped to its encoder or to `undefined` for one without a codec: a status that has a
  // schema is serialized by it, so it never falls back to a class or `default` that has an encoder.
  const encoders = new Map<string, ((value: unknown) => unknown) | undefined>()
  for (const [status, authored] of Object.entries(schema.response ?? {})) {
    encoders.set(status.toLowerCase(), compileEncoder(authored))
  }

  if (![...encoders.values()].some(encode => encode !== undefined)) {
    return
  }

  addRouteHook(routeDef, 'preSerialization', (_request, reply, payload, done) => {
    const status = String(reply.statusCode)
    const key = [status, `${status[0]}xx`, 'default'].find(candidate => encoders.has(candidate))
    const encode = key === undefined ? undefined : encoders.get(key)
    if (encode === undefined) {
      done(null, payload)
      return
    }

    try {
      done(null, encode(payload))
    } catch (error) {
      done(asError(error, 'encode the response'))
    }
  })
}

/** The schema a slot is validated against, or `undefined` for a slot it leaves alone. */
function validatedSlot(schema: RouteValidationSchema, slot: RequestSlot): AnySchema | undefined {
  const authored = schema[slot]
  return authored === undefined || (slot === 'body' && hasFileSchema(authored)) ? undefined : authored
}

function slotValidator(authored: AnySchema, slot: RequestSlot, context: string): SchemaValidator<unknown> {
  if (!isTypeBoxSchema(authored)) {
    return compileValidator(authored)
  }

  for (const name of formatsIn(authored)) {
    registerRouteFormat(name)
  }

  const policed = applySlotPolicy(slot === 'headers' ? (lowerCaseHeaders(authored) as AnySchema) : authored, slot)
  try {
    return compileValidator(policed)
  } catch (error) {
    throw compileError(error as Error, context)
  }
}

/** Why a slot's schema does not compile: a pattern no regular expression reads, or a kind TypeBox cannot check. */
function compileError(error: Error, context: string): ErrConfiguration {
  const failed = `Cannot compile the "${context}" schema`
  const message =
    error instanceof SyntaxError
      ? errMessage(`${failed}: a pattern in it is not a valid regular expression (${error.message})`).solutions(
          'Write the pattern as a regular expression with the "u" flag reads it, as Ajv does',
        )
      : errMessage(`${failed}: TypeBox cannot check it (${error.message})`).solutions(
          'Declare the slot with "$t" types TypeBox checks, such as "$t.String()" in place of "$t.Unsafe(...)"',
          'Register a custom kind with TypeBox\'s "TypeRegistry.Set(...)"',
        )
  return new ErrConfiguration(message.reference('@caffeinejs/http', ErrConfiguration).build())
}

/** What a headers schema may say about the names of the headers it checks. */
interface HeadersSchema {
  [key: string]: unknown
  properties?: Record<string, unknown>
  required?: string[]
  allOf?: HeadersSchema[]
  anyOf?: HeadersSchema[]
  not?: HeadersSchema
}

/**
 * A copy of a headers schema with every header name it declares lower-cased, so `Authorization` matches the
 * `authorization` Node delivers, as Fastify lower-cases a headers schema before Ajv compiles it. The names are those
 * TypeBox checks against the headers themselves: an object's, and those of each member of an intersection, a union or
 * a negation.
 */
function lowerCaseHeaders(schema: HeadersSchema): HeadersSchema {
  // Spread keeps a TypeBox schema's kind symbols, which the compiler reads.
  const copy = { ...schema }
  if (schema.properties !== undefined) {
    copy.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([name, property]) => [name.toLowerCase(), property]),
    )
  }
  if (schema.required !== undefined) {
    copy.required = schema.required.map(name => name.toLowerCase())
  }
  if (schema.allOf !== undefined) {
    copy.allOf = schema.allOf.map(lowerCaseHeaders)
  }
  if (schema.anyOf !== undefined) {
    copy.anyOf = schema.anyOf.map(lowerCaseHeaders)
  }
  if (schema.not !== undefined) {
    copy.not = lowerCaseHeaders(schema.not)
  }
  return copy
}

function validateFrom(
  index: number,
  request: FastifyRequest,
  validators: readonly SlotValidator[],
  formatter: ValidationErrorFormatter,
  done: (error?: Error) => void,
): void {
  for (let i = index; i < validators.length; i++) {
    const { slot, validate } = validators[i]
    const result = checkingFormats(request, () => validate(request[SLOT_PROPERTY[slot]]))

    // A Standard Schema that validates asynchronously: the rest of the slots wait for it.
    if (result instanceof Promise) {
      result.then(
        settled => {
          try {
            if (settle(request, slot, settled, formatter, done)) {
              validateFrom(i + 1, request, validators, formatter, done)
            }
          } catch (error) {
            done(asError(error, 'validate the request'))
          }
        },
        (error: unknown) => done(asError(error, 'validate the request')),
      )
      return
    }

    if (!settle(request, slot, result, formatter, done)) {
      return
    }
  }

  done()
}

/** Writes a slot's validated value onto the request; or, for a failure, ends or flags the request. Whether to go on. */
function settle(
  request: FastifyRequest,
  slot: RequestSlot,
  result: SchemaValidationResult<unknown>,
  formatter: ValidationErrorFormatter,
  done: (error?: Error) => void,
): boolean {
  if (result.ok) {
    // `headers` is a setter: what it is handed is laid over the raw headers, as for a Fastify validator's `value`.
    ;(request as unknown as Record<string, unknown>)[SLOT_PROPERTY[slot]] = result.value
    return true
  }

  const error = validationError(result.issues, slot, formatter)
  if (request.routeOptions.attachValidation) {
    request.validationError = error
    done()
  } else {
    done(error)
  }
  return false
}

/** The error Fastify raises for a failed validation, built from Caffeine's issues. */
function validationError(
  issues: readonly SchemaIssue[],
  slot: RequestSlot,
  formatter: ValidationErrorFormatter,
): ValidationError {
  const validation = issues.map<FastifySchemaValidationError>(issue => ({
    keyword: issue.code ?? '',
    instancePath: issue.path === '' ? '' : `/${issue.path.replaceAll('.', '/')}`,
    schemaPath: '',
    params: {},
    message: issue.message,
  }))

  const error = formatter(validation, slot) as ValidationError
  error.statusCode ||= 400
  error.code ||= 'FST_ERR_VALIDATION'
  error.validation = validation
  error.validationContext = slot
  return error
}

/** Fastify's own default formatter: `querystring/timeout <message>`, joined by commas. */
function formatValidationErrors(errors: FastifySchemaValidationError[], slot: RequestSlot): Error {
  return new Error(errors.map(error => `${slot}${error.instancePath} ${error.message}`).join(', '))
}

/**
 * Fastify reads a falsy `done(error)` as "go on", so whatever a schema throws or rejects with reaches it as an `Error`.
 */
function asError(error: unknown, action: string): Error {
  return error instanceof Error
    ? error
    : new Error(`Cannot ${action}: its schema failed with a non-error value`, { cause: error })
}

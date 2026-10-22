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
import { registerAjvFormats } from './_formats.js'
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
 * `format` as Ajv's `ajv-formats` does, and matches its header names lower-cased, as Node delivers them.
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
  registerAjvFormats()

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
 * either case), then `default`. fast-json-stringify then writes the encoded value as it would any other.
 */
export function attachResponseEncoding(routeDef: AdapterRouteOptions, schema: RouteValidationSchema): void {
  const encoders = new Map<string, (value: unknown) => unknown>()
  for (const [status, authored] of Object.entries(schema.response ?? {})) {
    const encode = compileEncoder(authored)
    if (encode !== undefined) {
      encoders.set(status.toLowerCase(), encode)
    }
  }

  if (encoders.size === 0) {
    return
  }

  addRouteHook(routeDef, 'preSerialization', (_request, reply, payload, done) => {
    const status = String(reply.statusCode)
    const encode = encoders.get(status) ?? encoders.get(`${status[0]}xx`) ?? encoders.get('default')
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

  const policed = applySlotPolicy(slot === 'headers' ? lowerCaseHeaders(authored) : authored, slot)
  try {
    return compileValidator(policed)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new ErrConfiguration(
      errMessage(`Cannot compile the "${context}" schema: TypeBox cannot check it (${reason})`)
        .solutions(
          'Declare the slot with "$t" types TypeBox checks, such as "$t.String()" in place of "$t.Unsafe(...)"',
          'Register a custom kind with TypeBox\'s "TypeRegistry.Set(...)"',
        )
        .reference('@caffeinejs/http', ErrConfiguration)
        .build(),
    )
  }
}

/** A copy of a headers schema with its property names lower-cased, so `Authorization` matches `authorization`. */
function lowerCaseHeaders<S extends object>(schema: S): S {
  const { properties, required } = schema as { properties?: Record<string, unknown>; required?: string[] }
  if (properties === undefined) {
    return schema
  }

  // Spread keeps the TypeBox kind symbols, which the compiler reads.
  return {
    ...schema,
    properties: Object.fromEntries(
      Object.entries(properties).map(([name, property]) => [name.toLowerCase(), property]),
    ),
    ...(required === undefined ? {} : { required: required.map(name => name.toLowerCase()) }),
  }
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
    const result = validate(request[SLOT_PROPERTY[slot]])

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

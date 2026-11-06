import type { FastifyError, FastifySchemaValidationError } from 'fastify'

import type { ProblemIssue, ProblemIssueSource } from '../../../core/error/problem.js'

// Fastify exports no name for the slot a validation error names.
export type ValidationSlot = NonNullable<FastifyError['validationContext']>

// Where an entry says each slot Fastify validates is: the parameter locations an OpenAPI document names.
const LOCATIONS = { body: 'body', querystring: 'query', params: 'path', headers: 'header' } as const

const NOUNS = {
  body: 'request body',
  querystring: 'query string',
  params: 'path parameters',
  headers: 'request headers',
} as const satisfies Record<ValidationSlot, string>

/** Whether `value` names a slot Fastify validates, which only a request validation failure carries. */
export function isValidationSlot(value: unknown): value is ValidationSlot {
  return typeof value === 'string' && Object.hasOwn(LOCATIONS, value)
}

/**
 * The code of an entry for a JSON Schema keyword: `ERR_VALIDATION_MIN_LENGTH` for `minLength`. A keyword with no
 * letter or digit gives `ERR_VALIDATION`.
 */
export function validationCode(keyword: string): string {
  const words = keyword
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase()

  return words === '' ? 'ERR_VALIDATION' : `ERR_VALIDATION_${words}`
}

/** The problem's `detail`: the slot that failed, and how many errors the list leaves out. */
export function validationDetail(slot: ValidationSlot, total: number, maxErrors: number): string {
  const sentence = `Invalid ${NOUNS[slot]}`

  return total > maxErrors ? `${sentence}: showing the first ${maxErrors} of ${total} errors` : sentence
}

/** The slot that failed and how many errors it had, for the error's message and the log line. */
export function validationMessage(slot: ValidationSlot, total: number): string {
  return `Invalid ${NOUNS[slot]}: ${total} ${total === 1 ? 'error' : 'errors'}`
}

/** The `schemaErrorFormatter` the adapter installs unless the application set one: the slot and the count. */
export function validationFormatter(errors: FastifySchemaValidationError[], slot: ValidationSlot): Error {
  return new Error(validationMessage(slot, Array.isArray(errors) ? errors.length : 0))
}

/** The entries of a validation problem: the first `maxErrors` of the errors Fastify's validator reported. */
export function validationIssues(
  errors: readonly FastifySchemaValidationError[],
  slot: ValidationSlot,
  maxErrors: number,
): ProblemIssue[] {
  return errors.slice(0, maxErrors).map(error => issueOf(error, slot))
}

function issueOf(error: FastifySchemaValidationError, slot: ValidationSlot): ProblemIssue {
  const params: Record<string, unknown> = { ...error.params }
  const segments = segmentsOf(error.instancePath)
  // Ajv reports a missing member at the object that lacks it, and names it unescaped.
  const missing = params.missingProperty
  const located = typeof missing === 'string' ? [...segments, escapeSegment(missing)] : segments
  // The field is the value that failed, so a missing member's message reads after the object that lacks it.
  const field = segments.at(-1)
  const message = error.message ?? 'is invalid'

  return {
    code: validationCode(typeof error.keyword === 'string' ? error.keyword : ''),
    detail: field === undefined ? message : `${unescapeSegment(field)} ${message}`,
    source: sourceOf(slot, located),
    params,
  }
}

function sourceOf(slot: ValidationSlot, segments: readonly string[]): ProblemIssueSource {
  const location = LOCATIONS[slot]

  if (location === 'body') {
    return { in: location, pointer: pointerOf(segments) }
  }

  const [name, ...rest] = segments
  if (name === undefined) {
    return { in: location }
  }

  return rest.length === 0
    ? { in: location, name: unescapeSegment(name) }
    : { in: location, name: unescapeSegment(name), pointer: pointerOf(rest) }
}

// Ajv's pointer, its segments still escaped: `''` for the slot itself, `/a~1b/0` below it.
function segmentsOf(instancePath: unknown): string[] {
  return typeof instancePath === 'string' && instancePath.startsWith('/') ? instancePath.split('/').slice(1) : []
}

function pointerOf(segments: readonly string[]): string {
  return segments.map(segment => `/${segment}`).join('')
}

// RFC 6901 §4: `~1` before `~0`, so `~01` reads as `~1` and not as `/`.
function unescapeSegment(segment: string): string {
  return segment.replaceAll('~1', '/').replaceAll('~0', '~')
}

function escapeSegment(name: string): string {
  return name.replaceAll('~', '~0').replaceAll('/', '~1')
}

import type { FastifySchemaValidationError } from 'fastify'

import type { ProblemIssue } from '../../../core/error/problem.js'
import {
  escapeSegment,
  sourceOf,
  unescapeSegment,
  validationCode,
  validationMessage,
  type ValidationSlot,
} from '../../../core/error/validation.js'

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

// Ajv's pointer, its segments still escaped: `''` for the slot itself, `/a~1b/0` below it.
function segmentsOf(instancePath: unknown): string[] {
  return typeof instancePath === 'string' && instancePath.startsWith('/') ? instancePath.split('/').slice(1) : []
}

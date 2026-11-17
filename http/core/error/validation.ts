import { errMessage } from '@caffeinejs/std/err'
import type { StandardSchemaV1 } from '@standard-schema/spec'

import type { IContext } from '../../context.js'
import { ErrCaffeineWebApplication } from './common.js'
import type { GlobalErrorHandlerOptions, ProblemIssueMapper } from './error.js'
import { newProblem, type Problem, type ProblemIssue, type ProblemIssueSource } from './problem.js'

/** A request slot a route schema validates. */
export type ValidationSlot = 'params' | 'querystring' | 'headers' | 'body'

/** The validation problem's settings, as the error handling feature bound them. */
export type ValidationProblem = Required<GlobalErrorHandlerOptions>['validation']

/** One rule a request broke: a Standard Schema issue, with `code` naming the rule when the validator knows one. */
export interface ValidationIssue extends StandardSchemaV1.Issue {
  readonly code?: string
}

/** The most characters of a path segment `ErrRequestValidation` quotes. */
const MAX_QUOTED = 64

/** What is logged when an application's issue mapper throws. */
export const CANNOT_MAP_ISSUE = 'Cannot map a validation issue: sending the issues as the framework built them'

// Where an entry says each slot is: the parameter locations an OpenAPI document names.
const LOCATIONS = { body: 'body', querystring: 'query', params: 'path', headers: 'header' } as const

const NOUNS = {
  body: 'request body',
  querystring: 'query string',
  params: 'path parameters',
  headers: 'request headers',
} as const satisfies Record<ValidationSlot, string>

/** Whether `value` names a slot a route schema validates. */
export function isValidationSlot(value: unknown): value is ValidationSlot {
  return typeof value === 'string' && Object.hasOwn(LOCATIONS, value)
}

/**
 * The code of an entry for a JSON Schema keyword: `ERR_VALIDATION_MIN_LENGTH` for `minLength`. A keyword with no
 * letter or digit gives `ERR_VALIDATION`.
 */
export function validationCode(keyword: string): string {
  // Each run of separators is one `_` by the time the ends are trimmed, so none of these backtracks.
  const words = keyword
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replaceAll(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .replaceAll(/[^A-Za-z0-9]+/g, '_')
    .replaceAll(/^_|_$/g, '')
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

/** Where an entry points, from the escaped segments of the path to the value that failed. */
export function sourceOf(slot: ValidationSlot, segments: readonly string[]): ProblemIssueSource {
  const location = LOCATIONS[slot]

  if (location === 'body') {
    return { in: location, pointer: pointerOf(segments) }
  }

  if (segments.length === 0) {
    return { in: location }
  }

  const [name, ...rest] = segments
  return rest.length === 0
    ? { in: location, name: unescapeSegment(name) }
    : { in: location, name: unescapeSegment(name), pointer: pointerOf(rest) }
}

/** RFC 6901 §4: `~1` before `~0`, so `~01` reads as `~1` and not as `/`. */
export function unescapeSegment(segment: string): string {
  return segment.replaceAll('~1', '/').replaceAll('~0', '~')
}

export function escapeSegment(name: string): string {
  return name.replaceAll('~', '~0').replaceAll('/', '~1')
}

/** The entry of a validation problem for one issue a Standard Schema reported on `slot`. */
export function standardIssue(slot: ValidationSlot, issue: ValidationIssue): ProblemIssue {
  const names = pathNames(issue)
  // The field is the value that failed, so the message reads after its name.
  const field = names.at(-1)

  return {
    code: validationCode(issue.code ?? ''),
    detail: field === undefined ? issue.message : `${field} ${issue.message}`,
    source: sourceOf(slot, names.map(escapeSegment)),
  }
}

/**
 * The problem a request that failed `slot` answers with: 422 for the body, 400 for the other slots. `issues` are the
 * entries sent, already cut to `maxErrors`, of `total` reported; nothing here trims or logs them. The application's
 * mapper rewrites each, and one that throws leaves the rest as built, `onMapFailure` hearing of it once.
 */
export function buildValidationProblem(
  ctx: IContext,
  slot: ValidationSlot,
  issues: readonly ProblemIssue[],
  total: number,
  validation: ValidationProblem,
  onMapFailure: (err: unknown) => void,
): Problem {
  const errors = validation.issue === undefined ? [...issues] : mapIssues(ctx, issues, validation.issue, onMapFailure)

  return newProblem({
    status: statusOf(slot),
    type: validation.type,
    title: validation.title,
    code: validation.code,
    detail: validationDetail(slot, total, validation.maxErrors),
    errors,
  })
}

/**
 * A request that failed its route's schema on one slot, with every issue the validator reported. It answers with the
 * validation problem the error handling settings describe, unless a `@Catch` handler takes it first.
 */
export class ErrRequestValidation extends ErrCaffeineWebApplication {
  /** 422 for the body, 400 for the other slots. */
  readonly statusCode: 400 | 422

  /**
   * @param route - The route the request was for, e.g. `POST /pets`.
   */
  constructor(
    readonly slot: ValidationSlot,
    readonly issues: readonly ValidationIssue[],
    route: string,
  ) {
    super(
      errMessage(failureLine(slot, issues, route))
        .reference('@caffeinejs/http', ErrRequestValidation)
        .build(),
      'ERR_REQUEST_VALIDATION',
    )
    this.name = 'ErrRequestValidation'
    this.statusCode = statusOf(slot)
  }
}

// What failed and where: a log or a catch handler keeping one line still knows where to look. The library's message
// is left out, as one may quote the value the client sent.
function failureLine(slot: ValidationSlot, issues: readonly ValidationIssue[], route: string): string {
  const failed = `Cannot accept the ${NOUNS[slot]} of "${route}"`
  const [first] = issues

  if (first === undefined) {
    return `${failed}: it does not match its schema`
  }

  // A record's keys are the client's: each is cut short, so the line stays bounded whatever was sent.
  const names = pathNames(first).map(name => (name.length > MAX_QUOTED ? `${name.slice(0, MAX_QUOTED)}…` : name))
  const where = names.length === 0 ? '' : ` at "${names.join('/')}"`
  const rule = first.code === undefined ? '' : `, which breaks "${first.code}"`
  return `${failed}: ${issues.length} ${issues.length === 1 ? 'error' : 'errors'}, the first${where}${rule}`
}

// The body's failures answer 422, the request's parameters' 400.
function statusOf(slot: ValidationSlot): 400 | 422 {
  return slot === 'body' ? 422 : 400
}

// The names on an issue's path, a segment written as an object read by its key.
function pathNames(issue: ValidationIssue): string[] {
  return (issue.path ?? []).map(segment => String(typeof segment === 'object' ? segment.key : segment))
}

function pointerOf(segments: readonly string[]): string {
  return segments.map(segment => `/${segment}`).join('')
}

// A mapper that throws is the application's bug, reported once per response rather than once per entry.
function mapIssues(
  ctx: IContext,
  issues: readonly ProblemIssue[],
  mapper: ProblemIssueMapper,
  onMapFailure: (err: unknown) => void,
): ProblemIssue[] {
  const mapped: ProblemIssue[] = []

  for (const issue of issues) {
    try {
      mapped.push(mapper(ctx, issue))
    } catch (err) {
      onMapFailure(err)
      return [...mapped, ...issues.slice(mapped.length)]
    }
  }

  return mapped
}

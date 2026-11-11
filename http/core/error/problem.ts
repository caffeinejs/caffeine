import { $t } from '@caffeinejs/application/schema'

import { statusPhrase } from '../../status.js'

/** The media type of a problem sent to a client that asks for one with `Accept: application/problem+json`. */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json'

/** The `type` of a problem nothing gave one: RFC 9457 §4.2.1, the status alone says what went wrong. */
const PROBLEM_TYPE_BLANK = 'about:blank'

/**
 * Where a {@link ProblemIssue} failed: a place in the request body, or a request parameter.
 *
 * `pointer` is an RFC 6901 JSON pointer: into the body, where `''` is the body itself, or into a parameter's value,
 * such as `/1` for the second value of `?ids=1&ids=x`. A parameter entry leaves it out when the failure is the value
 * as a whole. `name` is the parameter's name, unescaped, and is absent when the failure is the whole slot, such as
 * too few query parameters.
 *
 * `name`, `pointer` and the entry's `detail` can hold a key the client chose: escape them before writing them into
 * HTML.
 */
export type ProblemIssueSource =
  | { in: 'body'; pointer: string }
  | { in: 'query' | 'path' | 'header' | 'cookie'; name?: string; pointer?: string }

/**
 * One entry of a problem's `errors`: a rule a request broke.
 *
 * The framework lists one per error its validator reported for a request that fails its schema; an application lists
 * its own with `ErrHTTP.builder().errors(...)`.
 */
export interface ProblemIssue {
  /** What failed, to branch on, such as `ERR_VALIDATION_MIN_LENGTH`. */
  code: string
  /** What failed, written for the reader, such as `q must be >= 1`. */
  detail: string
  /** Where it failed. Absent on an entry that names no place. */
  source?: ProblemIssueSource
  /** What the rule was checked against, such as `{ limit: 3 }`. */
  params?: Record<string, unknown>
}

/**
 * An RFC 9457 problem details object: the body of every error response the framework renders itself.
 *
 * Any other member is an extension the application added to the error.
 */
export interface Problem {
  /** URI reference. `about:blank` unless the application set one. */
  type: string
  /**
   * A short summary of the kind of problem, the same on every occurrence. The status phrase for `status` unless the
   * error or the validation settings name one.
   */
  title: string
  /** Same number as the status line. */
  status: number
  /** This occurrence. Safe to show a client. */
  detail: string
  /** The error's code, such as `ERR_HTTP_NOT_FOUND`, or `ERR_VALIDATION` for a request that fails its schema. */
  code: string
  /** The class of error a client branches on, such as `rate_limit`. Present only when the application set one. */
  category?: string
  /**
   * What the reader, a person or an agent, should do next, such as when to retry. Present only when the
   * application set it.
   */
  what_you_should_do?: string
  /** URI reference. Present only when the application set one. */
  instance?: string
  /**
   * Each rule the request broke. Present on a request that fails its schema, at most `maxErrors` of them, and on an
   * `ErrHTTP` given entries.
   */
  errors?: ProblemIssue[]
  /**
   * Ties the response to the server's logs and traces: the request ID unless error handling was given a
   * provider. Absent when there is none. Present only on problems the framework sends.
   */
  correlation_id?: string
  /** When the problem was sent, ISO 8601 in UTC. Present only on problems the framework sends. */
  timestamp?: string
  /** Present only when `exposeStacktrace()` is on, and only on bodies the error handler renders. */
  stacktrace?: string
  [extension: string]: unknown
}

/**
 * The schema of a {@link Problem}, for a route that declares the error statuses it answers and for an OpenAPI
 * document. Extension members are allowed, so a response schema built on it does not strip them.
 */
export const ProblemSchema = $t.Object(
  {
    type: $t.String({ description: 'URI reference. `about:blank` unless the application set one.' }),
    title: $t.String({ description: 'A short summary of the kind of problem. The same on every occurrence.' }),
    status: $t.Integer({ description: 'Same number as the status line.' }),
    detail: $t.String({ description: 'This occurrence. Safe to show a client.' }),
    code: $t.String({ description: 'The error code, to look up.' }),
    category: $t.Optional($t.String({ description: 'The class of error, to branch on.' })),
    what_you_should_do: $t.Optional($t.String({ description: 'What to do next, such as when to retry.' })),
    instance: $t.Optional($t.String({ description: 'URI reference naming this occurrence.' })),
    errors: $t.Optional(
      $t.Array(
        $t.Object(
          {
            code: $t.String({ description: 'What failed, to branch on.' }),
            detail: $t.String({ description: 'What failed, written for the reader.' }),
            source: $t.Optional(
              $t.Object({
                in: $t.UnionEnum(['body', 'query', 'path', 'header', 'cookie']),
                name: $t.Optional($t.String({ description: 'The parameter. Absent when the whole slot failed.' })),
                pointer: $t.Optional(
                  $t.String({ description: 'An RFC 6901 JSON pointer into the body or the value.' }),
                ),
              }),
            ),
            params: $t.Optional(
              $t.Record($t.String(), $t.Unknown(), { description: 'What the rule was checked against.' }),
            ),
          },
          { $id: 'ProblemIssue' },
        ),
        { description: 'Each rule the request broke.' },
      ),
    ),
    correlation_id: $t.Optional($t.String({ description: "Ties the response to the server's logs and traces." })),
    timestamp: $t.Optional($t.String({ format: 'date-time', description: 'When the problem was sent, in UTC.' })),
    stacktrace: $t.Optional($t.String({ description: 'Present only on a development deployment.' })),
  },
  { $id: 'Problem', additionalProperties: true },
)

/** What {@link newProblem} builds a {@link Problem} from. */
export interface ProblemInit {
  status: number
  code: string
  /** The status phrase when absent. */
  title?: string
  /** The title when absent. */
  detail?: string
  type?: string
  instance?: string
  category?: string
  whatYouShouldDo?: string
  /** Left out of the problem when empty. */
  errors?: ProblemIssue[]
  extensions?: Readonly<Record<string, unknown>>
}

// The members a problem defines itself. An extension of the same name would change what they mean.
const MEMBERS = new Set([
  'type',
  'title',
  'status',
  'detail',
  'code',
  'category',
  'what_you_should_do',
  'instance',
  'errors',
  'correlation_id',
  'timestamp',
  'stacktrace',
])

/**
 * Builds a {@link Problem}, for a `@Catch` handler or a helper that answers with one.
 *
 * An extension named like a member of {@link Problem} is dropped, so it can neither replace one nor add a
 * `stacktrace` the application did not turn on. `correlation_id` and `timestamp` describe one response, so the
 * framework adds them when it sends the problem, not here.
 */
export function newProblem(init: ProblemInit): Problem {
  const title = init.title ?? statusPhrase(init.status) ?? 'Unknown Error'
  const extensions = Object.entries(init.extensions ?? {}).filter(([name]) => !MEMBERS.has(name))

  return {
    ...Object.fromEntries(extensions),
    type: init.type ?? PROBLEM_TYPE_BLANK,
    title,
    status: init.status,
    detail: init.detail ?? title,
    code: init.code,
    ...(init.category === undefined ? {} : { category: init.category }),
    ...(init.whatYouShouldDo === undefined ? {} : { what_you_should_do: init.whatYouShouldDo }),
    ...(init.instance === undefined ? {} : { instance: init.instance }),
    ...(init.errors === undefined || init.errors.length === 0 ? {} : { errors: init.errors }),
  }
}

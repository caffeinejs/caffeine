import { STATUS_CODES } from 'node:http'

import { $t, type SchemaIssue } from '@caffeinejs/application/schema'

/** The media type an error body is sent as unless `.errorHandling(e => e.problemContentType(...))` changed it. */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json'

/** The `type` of a problem nothing gave one: RFC 9457 §4.2.1, the status alone says what went wrong. */
const PROBLEM_TYPE_BLANK = 'about:blank'

/**
 * An RFC 9457 problem details object: the body of every error response the framework renders itself.
 *
 * Any other member is an extension the application added to the error.
 */
export interface Problem {
  /** URI reference. `about:blank` unless the application set one. */
  type: string
  /** Node's status phrase for `status`. Stable for that status. */
  title: string
  /** Same number as the status line. */
  status: number
  /** This occurrence. Safe to show a client. */
  detail: string
  /** The error's code, such as `ERR_HTTP_NOT_FOUND` or Fastify's `FST_ERR_VALIDATION`. */
  code: string
  /** URI reference. Present only when the application set one. */
  instance?: string
  /**
   * Present only on a schema failure: each rule that failed, its `path` dotted from the request slot
   * (`body.owner.name`) and its `code` the rule (`minLength`).
   */
  errors?: SchemaIssue[]
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
    title: $t.String({ description: 'The status phrase. Stable for that status.' }),
    status: $t.Integer({ description: 'Same number as the status line.' }),
    detail: $t.String({ description: 'This occurrence. Safe to show a client.' }),
    code: $t.String({ description: 'The error code, to look up.' }),
    instance: $t.Optional($t.String({ description: 'URI reference naming this occurrence.' })),
    errors: $t.Optional(
      $t.Array(
        $t.Object(
          {
            path: $t.String({ description: 'Dotted, starting with the request slot that failed.' }),
            message: $t.String(),
            code: $t.Optional($t.String({ description: 'The rule that failed.' })),
          },
          { $id: 'SchemaIssue' },
        ),
        { description: 'Each rule a schema failure broke.' },
      ),
    ),
    stacktrace: $t.Optional($t.String({ description: 'Present only on a development deployment.' })),
  },
  { $id: 'Problem', additionalProperties: true },
)

/** What {@link newProblem} builds a {@link Problem} from. */
export interface ProblemInit {
  status: number
  code: string
  /** The status phrase when absent. */
  detail?: string
  type?: string
  instance?: string
  errors?: SchemaIssue[]
  extensions?: Readonly<Record<string, unknown>>
}

// The members a problem defines itself. An extension of the same name would change what they mean.
const MEMBERS = new Set(['type', 'title', 'status', 'detail', 'code', 'instance', 'errors', 'stacktrace'])

/**
 * Builds a {@link Problem}, for a `@Catch` handler or a helper that answers with one.
 *
 * An extension named like a member of {@link Problem} is dropped, so it can neither replace one nor add a
 * `stacktrace` the application did not turn on.
 */
export function newProblem(init: ProblemInit): Problem {
  const title = statusPhrase(init.status)
  const extensions = Object.entries(init.extensions ?? {}).filter(([name]) => !MEMBERS.has(name))

  return {
    ...Object.fromEntries(extensions),
    type: init.type ?? PROBLEM_TYPE_BLANK,
    title,
    status: init.status,
    detail: init.detail ?? title,
    code: init.code,
    ...(init.instance === undefined ? {} : { instance: init.instance }),
    ...(init.errors === undefined ? {} : { errors: init.errors }),
  }
}

function statusPhrase(status: number): string {
  return STATUS_CODES[status] ?? 'Unknown Error'
}

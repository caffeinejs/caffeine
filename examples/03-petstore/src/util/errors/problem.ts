import type { Context } from '@caffeinejs/http'

// RFC 9457 Problem Details for HTTP APIs — mirrors components.schemas.Error in the OpenAPI spec.
export interface ProblemError {
  field: string
  message: string
  code?: string
}

export interface ProblemDetails {
  type: string
  title: string
  status: number
  detail?: string
  instance?: string
  errors?: ProblemError[]
}

// Status → problem type URI + title, matching the spec's example responses. Statuses not listed fall
// back to about:blank with a generic title.
const PROBLEM_TYPES: Record<number, { type: string, title: string }> = {
  400: { type: 'https://petstoreapi.com/errors/bad-request', title: 'Bad Request' },
  401: { type: 'https://petstoreapi.com/errors/unauthorized', title: 'Unauthorized' },
  403: { type: 'https://petstoreapi.com/errors/forbidden', title: 'Forbidden' },
  404: { type: 'https://petstoreapi.com/errors/not-found', title: 'Not Found' },
  405: { type: 'https://petstoreapi.com/errors/method-not-allowed', title: 'Method Not Allowed' },
  422: { type: 'https://petstoreapi.com/errors/validation-error', title: 'Validation Error' },
  429: { type: 'https://petstoreapi.com/errors/rate-limit-exceeded', title: 'Too Many Requests' },
  500: { type: 'https://petstoreapi.com/errors/internal-server-error', title: 'Internal Server Error' },
}

export function problemFor(
  status: number,
  detail?: string,
  extra?: Pick<ProblemDetails, 'instance' | 'errors'>,
): ProblemDetails {
  const known = PROBLEM_TYPES[status]

  return {
    type: known?.type ?? 'about:blank',
    title: known?.title ?? 'Error',
    status,
    ...(detail !== undefined ? { detail } : {}),
    ...(extra?.instance !== undefined ? { instance: extra.instance } : {}),
    ...(extra?.errors !== undefined ? { errors: extra.errors } : {}),
  }
}

// Renders a Problem Details body with the RFC 9457 media type. Fastify JSON-serializes the object and
// keeps the application/problem+json content type (the "+json" suffix is treated as JSON).
export function sendProblem(ctx: Context, problem: ProblemDetails): void {
  ctx.header('content-type', 'application/problem+json').status(problem.status).body(problem)
}

// The request path, without the query string, for the problem "instance" member.
export function instanceOf(ctx: Context): string {
  const url = ctx.req.url
  const q = url.indexOf('?')
  return q === -1 ? url : url.slice(0, q)
}

import type { IContext } from '../../context.js'
import { statusPhrase } from '../../status.js'
import type { CorrelationIDProvider, GlobalErrorHandlerOptions } from './error.js'
import type { Problem } from './problem.js'
import { negotiateProblemFormat } from './serializer.js'

/** A problem encoded for the request it answers: the media type its client negotiated, and the body. */
export interface EncodedProblem {
  contentType: string
  body: string
}

/** Where encoding logs what it could not do: the application's logger. */
export interface ProblemLog {
  error(obj: object, msg: string): void
}

/** Encodes a problem for one request: negotiated on `accept`, stamped with correlation ID, timestamp and, when exposed, the stack. */
export type ProblemEncoder = (
  accept: string | undefined,
  ctx: IContext,
  problem: Problem,
  log: ProblemLog,
  err?: Error,
) => EncodedProblem

const JSON_CONTENT_TYPE = 'application/json'

// A cause chain is walked on a request path, and one can be circular as well as long.
const MAX_CAUSE_DEPTH = 10

export function problemEncoder({
  exposeStacktrace,
  formats,
  correlationID,
}: Required<GlobalErrorHandlerOptions>): ProblemEncoder {
  return (accept, ctx, problem, log, err) => {
    const format = negotiateProblemFormat(accept, formats)
    const stamped: Problem = {
      ...problem,
      ...correlationOf(log, ctx, correlationID),
      timestamp: new Date().toISOString(),
      ...(exposeStacktrace && err !== undefined ? { stacktrace: stacktraceOf(err) } : {}),
    }

    // An error page that fails must not cost the client the error it describes.
    try {
      return { contentType: withCharset(format.mediaType), body: format.serialize(ctx, stamped) }
    } catch (cause) {
      log.error(
        { err: cause },
        `Cannot serialize a problem as "${format.mediaType}": sending it as ${JSON_CONTENT_TYPE} instead`,
      )
      return { contentType: JSON_CONTENT_TYPE, body: JSON.stringify(stamped) }
    }
  }
}

// The body is a string, which goes out as UTF-8. Fastify says so only for a JSON type; a Markdown or HTML page needs
// it too, or a client may decode it as something else.
export function withCharset(mediaType: string): string {
  return /;\s*charset=/i.test(mediaType) ? mediaType : `${mediaType}; charset=utf-8`
}

function correlationOf(
  log: ProblemLog,
  ctx: IContext,
  provider: CorrelationIDProvider,
): Pick<Problem, 'correlation_id'> {
  try {
    const id = provider(ctx)
    return typeof id === 'string' && id !== '' ? { correlation_id: id } : {}
  } catch (err) {
    log.error({ err }, 'Cannot read the correlation ID: sending the problem without one')
    return {}
  }
}

/** An error that names what a client may be told, apart from the `message` written for whoever reads the log. */
export interface ErrorWithPublicMessage extends Error {
  statusCode: number
  code: string
  publicMessage: string
}

export function hasPublicMessage(err: Error): err is ErrorWithPublicMessage {
  const candidate = err as Partial<ErrorWithPublicMessage>

  return (
    typeof candidate.publicMessage === 'string' &&
    typeof candidate.code === 'string' &&
    typeof candidate.statusCode === 'number'
  )
}

// The status Fastify itself would answer with, so a body rendered here lands on the same one its default
// handler would have chosen: `statusCode`, then `status`, and only a value that is already an error.
export function errorStatus(err: Error): number {
  const candidate = err as Partial<{ statusCode: number; status: number }>
  const status = candidate.statusCode ?? candidate.status

  return typeof status === 'number' && status >= 400 ? status : 500
}

// The code an `ErrHTTP*` of that status carries, for a 4xx error that names none: `ERR_HTTP_IM_A_TEAPOT` for 418.
export function codeForStatus(status: number): string {
  const phrase = statusPhrase(status)

  return phrase === undefined
    ? 'ERR_HTTP'
    : `ERR_HTTP_${phrase
        .replaceAll("'", '')
        .toUpperCase()
        .replaceAll(/[^A-Z0-9]+/g, '_')}`
}

// Node prints a cause as a "Caused by" section of its own, and that section is usually where the detail is —
// a rejected `fetch` says only "fetch failed" until its cause names the address.
function stacktraceOf(err: Error): string {
  const sections = [sectionOf(err)]
  const seen = new Set<unknown>([err])
  let cause: unknown = (err as { cause?: unknown }).cause

  while (cause instanceof Error && !seen.has(cause) && sections.length < MAX_CAUSE_DEPTH) {
    seen.add(cause)
    sections.push(`Caused by: ${sectionOf(cause)}`)
    cause = (cause as { cause?: unknown }).cause
  }

  return sections.join('\n')
}

function sectionOf(err: Error): string {
  return err.stack ?? `${err.name}: ${err.message}`
}

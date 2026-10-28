import { STATUS_CODES } from 'node:http'

import type { SchemaIssue } from '@caffeinejs/application/schema'
import { errMessage } from '@caffeinejs/std/err'
import type {
  FastifyError,
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
  FastifySchemaValidationError,
} from 'fastify'
import fp from 'fastify-plugin'

import { ErrCaffeineWebApplication } from '../../../core/error/common.js'
import type { GlobalErrorHandlerOptions } from '../../../core/error/error.js'
import { ErrorHandlerProvider, resolveByErrorChain } from '../../../core/error/handler.js'
import { ErrHTTP } from '../../../core/error/http.js'
import { newProblem, type Problem } from '../../../core/error/problem.js'
import { kErrorUnhandled, type IRouteGroup } from '../../../core/routing/route.js'
import type { Context } from '../context.js'
import { cookieFlushFailed } from '../cookie/cookie.js'
import { answer, payloadOf } from '../response.js'

export type GlobalErrorHandler = (error: FastifyError, request: FastifyRequest, reply: FastifyReply) => Promise<unknown>

const kProblemContentType = Symbol('caffeine.http.problem-content-type')

interface ProblemInstance {
  [kProblemContentType]: string
}

// A cause chain is walked on a request path, and one can be circular as well as long.
const MAX_CAUSE_DEPTH = 10

/**
 * Holds the application-wide handler the {@link globalErrorHandlerPlugin} installed.
 *
 * Built by the adapter for each server and read back once that server's plugins have installed, because each
 * route group's own encapsulated handler falls back to it rather than installing one of its own.
 */
export class GlobalErrorHandlerRef {
  #handler: GlobalErrorHandler | undefined

  get handler(): GlobalErrorHandler {
    if (this.#handler === undefined) {
      throw new ErrCaffeineWebApplication(
        errMessage('Cannot read the global error handler: the error handling plugin has not registered yet')
          .reference('@caffeinejs/http', ErrCaffeineWebApplication)
          .build(),
        'ERR_ERROR_HANDLER_NOT_INSTALLED',
      )
    }

    return this.#handler
  }

  set handler(handler: GlobalErrorHandler) {
    this.#handler = handler
  }
}

/**
 * Installs the application-wide error handler on the root server.
 *
 * Installed by the adapter ahead of every other plugin, so every route and hook registered afterwards is already
 * covered by it — including the ones a package outside `http` contributes.
 */
export function globalErrorHandlerPlugin(
  ref: GlobalErrorHandlerRef,
  options: Required<GlobalErrorHandlerOptions>,
): FastifyPluginAsync {
  const plugin: FastifyPluginAsync = async instance => {
    instance.decorate(kProblemContentType, options.problemContentType)
    ref.handler = installGlobalErrorHandler(instance, instance.$container.get(ErrorHandlerProvider), options)
  }

  return fp(plugin, { name: 'caffeine-error-handling' })
}

/**
 * The media type the server `request` came to sends a problem as. Every server the adapter builds installs the
 * error handling plugin first, so the decoration is there before any route can answer.
 */
export function problemContentType(request: FastifyRequest): string {
  return (request.server as unknown as ProblemInstance)[kProblemContentType]
}

/**
 * Installs the application-wide error handler on the root instance, and returns it so the encapsulated
 * per-controller handlers can fall back to it.
 *
 * Called before anything else is wired, so a route or hook registered afterwards is covered by it.
 */
export function installGlobalErrorHandler(
  fastify: FastifyInstance,
  errorManager: ErrorHandlerProvider,
  options: Required<GlobalErrorHandlerOptions>,
): GlobalErrorHandler {
  const { exposeStacktrace, problemContentType: contentType } = options

  // Under the problem media type whatever the request accepts: the body is a problem either way, and a client
  // reading `application/json` reads it as well.
  const sendProblem = (reply: FastifyReply, problem: Problem, err: Error): FastifyReply =>
    reply
      .status(problem.status)
      .type(contentType)
      .send(exposeStacktrace ? { ...problem, stacktrace: stacktraceOf(err) } : problem)

  // The application-wide error handler. Also the fallback for per-controller (encapsulated) handlers
  // when they do not handle a given error type.
  const globalErrorHandler: GlobalErrorHandler = async (error, request, reply) => {
    const err = error instanceof Error ? error : new Error(String(error))
    const handler = errorManager.provide(err)

    if (handler) {
      // The handler may respond via ctx or return a value (JSON payload or a View to render).
      return respond(request.httpContext, await handler.get().handle(request.httpContext, err))
    }

    if (err instanceof ErrHTTP) {
      if (err.headers) {
        reply.headers(err.headers)
      }

      if (err.body === undefined) {
        return sendProblem(reply, err.toProblem(), err)
      }

      // A body the error carried is the author's own and is sent as it stands, under the media type the reply
      // already has — it need not be an object, so there is nothing to add a stack trace to.
      // The error's status stands over a Response given as its body.
      return reply.status(err.statusCode).send(payloadOf(reply, err.body, true))
    }

    // Its message is detail for the log: an issuer, the address a provider could not be reached at.
    if (hasPublicMessage(err)) {
      request.log[err.statusCode >= 500 ? 'error' : 'info']({ err }, err.message)

      return sendProblem(reply, newProblem({ status: err.statusCode, code: err.code, detail: err.publicMessage }), err)
    }

    const status = errorStatus(err)

    // A 4xx describes what the caller got wrong — a failed validation, a body over the limit, JSON that does not
    // parse — so its message is written for them and answers as the detail, Fastify's own code kept.
    if (status < 500) {
      request.log.info({ err }, err.message)

      // Fastify writes the headers its own errors carry, a 405's `Allow` among them.
      const headers = (err as { headers?: Record<string, string> }).headers
      if (headers !== undefined) {
        reply.headers(headers)
      }

      const code = (err as { code?: unknown }).code
      const validation = (err as Partial<FastifyError>).validation

      return sendProblem(
        reply,
        newProblem({
          status,
          code: typeof code === 'string' ? code : codeForStatus(status),
          detail: err.message,
          ...(validation === undefined
            ? {}
            : { errors: problemErrors(validation, (err as Partial<FastifyError>).validationContext) }),
        }),
        err,
      )
    }

    // Nothing here was written for a client: a table name, a driver code, the address of a service that did
    // not answer. It stays in the log, and the response names the status and nothing else.
    request.log.error({ err }, err.message)

    return sendProblem(reply, newProblem({ status, code: 'ERR_INTERNAL' }), err)
  }

  fastify.setErrorHandler(globalErrorHandler)

  return globalErrorHandler
}

/**
 * Installs a route group's encapsulated error handler, when it declares one.
 *
 * Called from inside the group's `register()` context, so the handler it sets covers every phase of
 * that plugin — validation, hooks, and the handler itself — and nothing outside it.
 */
export function installRouteGroupErrorHandler(
  server: FastifyInstance,
  router: IRouteGroup<any>,
  globalErrorHandler: GlobalErrorHandler,
): void {
  const routes = router.routes

  // A single encapsulated setErrorHandler covers every phase in the plugin (validation, hooks,
  // handler) and resolves, most specific first: the route's @CatchWith, the group's @CatchWith, the
  // group's own handler, then the app-wide globalErrorHandler.
  const groupHandler = router.handleError
  const hasScopedHandlers =
    groupHandler !== undefined || !!router.catchBy?.size || routes.some(route => route.catchBy?.size)

  if (!hasScopedHandlers) {
    return
  }

  const routerCatchBy = router.catchBy

  server.setErrorHandler(async (error: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
    const err = error instanceof Error ? error : new Error(String(error))

    // routeOptions is populated before validation, so route-level handlers also see schema errors.
    const routeCatchBy = req.routeOptions.config?.$caffeine?.compiled?.catchBy
    const handler =
      (routeCatchBy ? resolveByErrorChain(routeCatchBy, err) : undefined) ??
      (routerCatchBy ? resolveByErrorChain(routerCatchBy, err) : undefined)

    if (handler) {
      return respond(req.httpContext, await handler.get().handle(req.httpContext, err))
    }

    if (groupHandler !== undefined) {
      const result = await groupHandler(req, req.httpContext, err)

      if (result !== kErrorUnhandled) {
        return respond(req.httpContext, result)
      }
    }

    return globalErrorHandler(error, req, reply)
  })
}

/** An error that names what a client may be told, apart from the `message` written for whoever reads the log. */
interface ErrorWithPublicMessage extends Error {
  statusCode: number
  code: string
  publicMessage: string
}

function hasPublicMessage(err: Error): err is ErrorWithPublicMessage {
  const candidate = err as Partial<ErrorWithPublicMessage>

  return (
    typeof candidate.publicMessage === 'string' &&
    typeof candidate.code === 'string' &&
    typeof candidate.statusCode === 'number'
  )
}

// The status Fastify itself would answer with, so a body rendered here lands on the same one its default
// handler would have chosen: `statusCode`, then `status`, and only a value that is already an error.
function errorStatus(err: Error): number {
  const candidate = err as Partial<{ statusCode: number; status: number }>
  const status = candidate.statusCode ?? candidate.status

  return typeof status === 'number' && status >= 400 ? status : 500
}

// The code an `ErrHTTP*` of that status carries, for a 4xx error that names none: `ERR_HTTP_IM_A_TEAPOT` for 418.
function codeForStatus(status: number): string {
  const phrase = STATUS_CODES[status]

  return phrase === undefined
    ? 'ERR_HTTP'
    : `ERR_HTTP_${phrase
        .replaceAll("'", '')
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '_')}`
}

// Ajv reports where a value failed as a JSON pointer inside the slot, and a missing property at the object that
// lacks it. Both become one dotted path from the slot, as a configuration issue is written.
function problemErrors(validation: FastifySchemaValidationError[], slot: string | undefined): SchemaIssue[] {
  return validation.map(issue => {
    const segments = issue.instancePath
      .split('/')
      .slice(1)
      .map(segment => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
    const missing = (issue.params as { missingProperty?: unknown } | undefined)?.missingProperty
    if (typeof missing === 'string') {
      segments.push(missing)
    }

    return {
      path: [...(slot === undefined ? [] : [slot]), ...segments].join('.'),
      message: issue.message ?? 'is invalid',
      code: issue.keyword,
    }
  })
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

// The handler answered from the context. Handed the reply back, the runner waits for that send out rather than
// sending this over it — `reply.sent` alone is still false while an `onSend` hook holds it open, and this runs inside
// an async `setErrorHandler`, whose `undefined` the server takes as a request to send. Unless that answer died writing
// its cookies, which is the error being handled: nothing is in flight to wait for, and the wait would hang the request.
// An answer from the catch handler itself reopened them first.
function answeredOnError(ctx: Context): boolean {
  return ctx.sent && !cookieFlushFailed(ctx.platform.reply)
}

function respond(ctx: Context, result: unknown): unknown {
  return answer(ctx.platform.reply, ctx, result, answeredOnError)
}

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

import type { IContext } from '../../../context.js'
import { ErrCaffeineWebApplication } from '../../../core/error/common.js'
import {
  codeForStatus,
  errorStatus,
  hasPublicMessage,
  problemEncoder,
  type EncodedProblem,
  type ProblemEncoder,
} from '../../../core/error/encode.js'
import type { GlobalErrorHandlerOptions } from '../../../core/error/error.js'
import { ErrorHandlerProvider, resolveByErrorChain } from '../../../core/error/handler.js'
import { ErrHTTP } from '../../../core/error/http.js'
import { newProblem, type Problem } from '../../../core/error/problem.js'
import {
  buildValidationProblem,
  CANNOT_MAP_ISSUE,
  isValidationSlot,
  validationMessage,
  type ValidationProblem,
  type ValidationSlot,
} from '../../../core/error/validation.js'
import { kErrorUnhandled, type IRouteGroup } from '../../../core/routing/route.js'
import { payloadOf } from '../../../core/server/answer.js'
import { appendVary } from '../../../vary.js'
import type { Context } from '../context.js'
import { cookieFlushFailed } from '../cookie/cookie.js'
import { runOnErrorOnce, type FastifyErrorEntry } from '../lifecycle/lifecycle.js'
import { answer } from '../response.js'
import { validationIssues } from './validation.js'

export type GlobalErrorHandler = (error: FastifyError, request: FastifyRequest, reply: FastifyReply) => Promise<unknown>

/** The context of a request, made when no hook has made it yet: one an earlier `onRequest` hook failed. */
export type ContextOf = (request: FastifyRequest, reply: FastifyReply) => Context

const kProblemEncoder = Symbol('caffeine.http.problem-encoder')
const kContextOf = Symbol('caffeine.http.context-of')

interface ProblemInstance {
  [kProblemEncoder]: ProblemEncoder
  [kContextOf]: ContextOf
}

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
  contextOf: ContextOf,
  rootOnError: readonly FastifyErrorEntry[],
): FastifyPluginAsync {
  const plugin: FastifyPluginAsync = async instance => {
    instance.decorate(kProblemEncoder, problemEncoder(options))
    instance.decorate(kContextOf, contextOf)
    ref.handler = installGlobalErrorHandler(
      instance,
      instance.$container.get(ErrorHandlerProvider),
      options.validation,
      rootOnError,
    )
  }

  return fp(plugin, { name: 'caffeine-error-handling' })
}

/**
 * Encodes `problem` in the format the request's `Accept` asks for, stamped with its `correlation_id` and
 * `timestamp`, for a helper that answers with one. Every server the adapter builds installs the error handling
 * plugin first, so the encoder is there before any route can answer.
 */
export function encodeProblem(request: FastifyRequest, problem: Problem): EncodedProblem {
  const encode = (request.server as unknown as ProblemInstance)[kProblemEncoder]

  return encode(request.headers.accept, request.httpContext, problem, request.log)
}

// The request's context, made here when an `onRequest` hook ahead of the adapter's failed before it could.
function contextOf(request: FastifyRequest, reply: FastifyReply): Context {
  return (request.server as unknown as ProblemInstance)[kContextOf](request, reply)
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
  validation: ValidationProblem,
  rootOnError: readonly FastifyErrorEntry[],
): GlobalErrorHandler {
  // In the format the request asks for, so the response varies on Accept. Encoded here, so a route's error
  // response schema, written for the bodies the application sends, neither refuses a problem nor strips its members.
  const sendProblem = (request: FastifyRequest, reply: FastifyReply, problem: Problem, err: Error): FastifyReply => {
    const { contentType, body } = (request.server as unknown as ProblemInstance)[kProblemEncoder](
      request.headers.accept,
      request.httpContext,
      problem,
      request.log,
      err,
    )
    appendVary(reply, ['Accept'])

    return reply.status(problem.status).type(contentType).send(body)
  }

  const sendErrHTTP = (request: FastifyRequest, reply: FastifyReply, err: ErrHTTP): FastifyReply => {
    if (err.headers) {
      reply.headers(err.headers)
    }

    if (err.body === undefined) {
      return sendProblem(request, reply, err.toProblem(), err)
    }

    // A body the error carried is the author's own and is sent as it stands, under the media type the reply
    // already has — it need not be an object, so there is nothing to add a stack trace to.
    // The error's status stands over a Response given as its body.
    return reply.status(err.statusCode).send(payloadOf(reply, err.body, true))
  }

  // The application-wide error handler. Also the fallback for per-controller (encapsulated) handlers
  // when they do not handle a given error type.
  const globalErrorHandler: GlobalErrorHandler = async (error, request, reply) => {
    const err = error instanceof Error ? error : new Error(String(error))
    const ctx = contextOf(request, reply)

    // The `onError` hooks observe first; a group's handler that fell back here already ran them.
    await runOnErrorOnce(request, request.routeOptions.config?.$caffeine?.compiled?.onError ?? rootOnError, err)

    const handler = errorManager.provide(err)

    if (handler) {
      // The handler may respond via ctx or return a value (JSON payload or a View to render).
      return respond(ctx, await handler.get().handle(ctx, err))
    }

    // A request that fails its schema: Fastify names the slot on that error, whichever validator ran. It names it on a
    // validator that threw too, marked 500: that is the server's failure, and the paths below answer it as one.
    const slot = (err as Partial<FastifyError>).validationContext
    if (isValidationSlot(slot) && errorStatus(err) < 500) {
      return sendProblem(request, reply, validationProblem(request, ctx, err, slot, validation), err)
    }

    if (err instanceof ErrHTTP) {
      return sendErrHTTP(request, reply, err)
    }

    // Its message is detail for the log: an issuer, the address a provider could not be reached at.
    if (hasPublicMessage(err)) {
      request.log[err.statusCode >= 500 ? 'error' : 'info']({ err }, err.message)

      return sendProblem(
        request,
        reply,
        newProblem({ status: err.statusCode, code: err.code, detail: err.publicMessage }),
        err,
      )
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

      return sendProblem(
        request,
        reply,
        newProblem({ status, code: typeof code === 'string' ? code : codeForStatus(status), detail: err.message }),
        err,
      )
    }

    // Nothing here was written for a client: a table name, a driver code, the address of a service that did
    // not answer. It stays in the log, and the response names the status and nothing else.
    request.log.error({ err }, err.message)

    return sendProblem(request, reply, newProblem({ status, code: 'ERR_INTERNAL' }), err)
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
  rootOnError: readonly FastifyErrorEntry[],
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
    const ctx = contextOf(req, reply)

    // The `onError` hooks observe first, once: the global handler this falls back to does not run them again.
    await runOnErrorOnce(req, req.routeOptions.config?.$caffeine?.compiled?.onError ?? rootOnError, err)

    // routeOptions is populated before validation, so route-level handlers also see schema errors.
    const routeCatchBy = req.routeOptions.config?.$caffeine?.compiled?.catchBy
    const handler =
      (routeCatchBy ? resolveByErrorChain(routeCatchBy, err) : undefined) ??
      (routerCatchBy ? resolveByErrorChain(routerCatchBy, err) : undefined)

    if (handler) {
      return respond(ctx, await handler.get().handle(ctx, err))
    }

    if (groupHandler !== undefined) {
      const result = await groupHandler(req, ctx, err)

      if (result !== kErrorUnhandled) {
        return respond(ctx, result)
      }
    }

    return globalErrorHandler(error, req, reply)
  })
}

// The body's failures answer 422, the request's parameters' 400. The log line is bounded like the response: the slot,
// the count and the entries sent, never the validator's own array or a message joined from it.
function validationProblem(
  request: FastifyRequest,
  ctx: IContext,
  err: Error,
  slot: ValidationSlot,
  validation: ValidationProblem,
): Problem {
  const reported = reportedErrors(err)

  // A validator compiled by the application returned an `Error` of its own, so there is nothing to list.
  if (reported === undefined) {
    request.log.info({ err }, err.message)
    return buildValidationProblem(ctx, slot, [], 0, validation, () => undefined)
  }

  const total = reported.length
  const problem = buildValidationProblem(
    ctx,
    slot,
    validationIssues(reported, slot, validation.maxErrors),
    total,
    validation,
    failure => request.log.error({ err: failure }, CANNOT_MAP_ISSUE),
  )

  request.log.info({ validation: { slot, total, errors: problem.errors } }, validationMessage(slot, total))

  return problem
}

// Fastify's list, or the one Ajv rejects an `$async` schema with: an error of Ajv's own, the list under `errors`.
function reportedErrors(err: Error): FastifySchemaValidationError[] | undefined {
  const { validation, ajv, errors } = err as Partial<FastifyError> & { ajv?: unknown; errors?: unknown }

  if (Array.isArray(validation)) {
    return validation
  }

  return ajv === true && Array.isArray(errors) ? (errors as FastifySchemaValidationError[]) : undefined
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

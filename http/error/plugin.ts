import type { FastifyError, FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'

import type { FastifyContext } from '../fastify_context.js'
import { Responder } from '../response.js'
import { kErrorUnhandled, type RouteGroup } from '../routing/route.js'
import { ErrCaffeineWebApplication } from './common.js'
import { ErrorHandlerProvider, resolveByErrorChain } from './handler.js'
import { ErrHTTP, httpErrorBody, statusErrorBody, type HTTPErrorBody } from './http.js'

export type GlobalErrorHandler = (error: FastifyError, request: FastifyRequest, reply: FastifyReply) => Promise<unknown>

// A cause chain is walked on a request path, and one can be circular as well as long.
const MAX_CAUSE_DEPTH = 10

/** What the error-handling feature settled on, handed to the plugin it builds. */
export interface GlobalErrorHandlerOptions {
  /**
   * Sends the stack, and the chain of causes behind it, as `stacktrace` on every body this package renders.
   *
   * Off by default. An error this package did not render — a body an `ErrHTTP` carried, anything a `@Catch`
   * handler returned, and the 4xx Fastify answers itself — is left alone either way.
   */
  exposeStacktrace?: boolean
}

/**
 * Holds the application-wide handler the {@link globalErrorHandlerPlugin} installed.
 *
 * Bound by the error-handling feature and read back by the adapter, because each route group's own
 * encapsulated handler falls back to it rather than installing one of its own.
 */
export class GlobalErrorHandlerRef {
  #handler: GlobalErrorHandler | undefined

  get handler(): GlobalErrorHandler {
    if (this.#handler === undefined) {
      throw new ErrCaffeineWebApplication(
        'Cannot read the global error handler: the error handling plugin has not registered yet',
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
 * Contributed by the feature the application bootstraps first, so every route and hook registered afterwards
 * is already covered by it — including the ones a package outside `http` contributes.
 */
export function globalErrorHandlerPlugin(
  ref: GlobalErrorHandlerRef,
  options?: GlobalErrorHandlerOptions,
): FastifyPluginAsync {
  const plugin: FastifyPluginAsync = async instance => {
    ref.handler = installGlobalErrorHandler(instance, instance.$container.get(ErrorHandlerProvider), options)
  }

  return fp(plugin, { name: 'caffeine-error-handling' })
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
  options?: GlobalErrorHandlerOptions,
): GlobalErrorHandler {
  const defaultErrorHandler = fastify.errorHandler
  const exposeStacktrace = options?.exposeStacktrace ?? false

  const withStacktrace = (body: HTTPErrorBody, err: Error): HTTPErrorBody =>
    exposeStacktrace ? { ...body, stacktrace: stacktraceOf(err) } : body

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
      reply.status(err.statusCode)

      if (err.headers) {
        reply.headers(err.headers)
      }

      // A body the error carried is the author's own and is sent as it stands — it need not be an object,
      // so there is nothing to add a stack trace to.
      const body = err.body !== undefined ? err.body : withStacktrace(httpErrorBody(err), err)

      return reply.send(body)
    }

    // Its message is detail for the log: an issuer, the address a provider could not be reached at.
    if (hasPublicMessage(err)) {
      request.log[err.statusCode >= 500 ? 'error' : 'info']({ err }, err.message)

      return reply
        .status(err.statusCode)
        .send(withStacktrace(statusErrorBody(err.statusCode, err.code, err.publicMessage), err))
    }

    const status = errorStatus(err)

    // A 4xx describes what the caller got wrong, so its message is written for them and Fastify's own
    // rendering — the field-level detail of a failed validation — is what answers.
    if (status < 500) {
      request.log.info({ err }, err.message)

      // The default handler sends the reply itself. Handed back as the result, the reply tells the runner so;
      // `undefined` would have it send again while an asynchronous `onSend` hook still holds the first response.
      defaultErrorHandler(error, request, reply)

      return reply
    }

    // Nothing here was written for a client: a table name, a driver code, the address of a service that did
    // not answer. It stays in the log, and the response names the status and nothing else.
    request.log.error({ err }, err.message)

    return reply.status(status).send(withStacktrace(statusErrorBody(status, 'ERR_INTERNAL'), err))
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
  router: RouteGroup<any>,
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

function respond(ctx: FastifyContext, result: unknown): unknown {
  const reply = ctx.platform.reply

  // The handler answered from the context. Handed the reply back, the runner waits for that send out rather
  // than sending this over it — `reply.sent` alone is still false while an `onSend` hook holds it open, and
  // this runs inside an async `setErrorHandler`, whose `undefined` the server takes as a request to send.
  if (ctx.sent) {
    return reply
  }

  if (result instanceof Responder) {
    return result.respond(ctx)
  }

  if (result !== undefined) {
    return result
  }

  reply.send()

  return reply
}

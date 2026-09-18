import type { FastifyError, FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'

import type { FastifyContext } from '../fastify_context.js'
import { Responder } from '../response.js'
import { kErrorUnhandled, type RouteGroup } from '../route.js'
import { ErrCaffeineWebApplication } from './common.js'
import { ErrorHandlerProvider, resolveByErrorChain } from './error.js'
import { ErrHTTP, httpErrorBody } from './http.js'

export type GlobalErrorHandler = (error: FastifyError, request: FastifyRequest, reply: FastifyReply) => Promise<unknown>

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
export function globalErrorHandlerPlugin(ref: GlobalErrorHandlerRef): FastifyPluginAsync {
  const plugin: FastifyPluginAsync = async instance => {
    ref.handler = installGlobalErrorHandler(instance, instance.$container.get(ErrorHandlerProvider))
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
): GlobalErrorHandler {
  const defaultErrorHandler = fastify.errorHandler

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

      const body = err.body !== undefined ? err.body : httpErrorBody(err)

      return reply.send(body)
    }

    request.log.error({ err }, err.message)

    return defaultErrorHandler(error, request, reply)
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
    const routeCatchBy = req.routeOptions.config?.$caffeine?.catchBy
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

function respond(ctx: FastifyContext, result: unknown): unknown {
  const reply = ctx.platform.reply

  if (reply.sent) {
    return
  }

  if (result instanceof Responder) {
    return result.respond(ctx)
  }

  if (result !== undefined) {
    return result
  }

  return reply.send()
}

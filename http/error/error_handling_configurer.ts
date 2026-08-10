import { Scopes } from '@caffeinejs/di'
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify'
import { FeatureConfigurer, type RouterPhaseContext, type ServerPhaseContext } from '../feature_configurer.js'
import { resolveByErrorChain } from './error.js'
import { ErrHTTP } from './http.js'

type GlobalErrorHandler = (error: FastifyError, request: FastifyRequest, reply: FastifyReply) => Promise<unknown>

/**
 * Wires error handling. `configureServer` installs the application-wide handler on the root instance;
 * `configureRouter` installs the encapsulated per-controller/route handler that resolves the most
 * specific `@CatchBy`/`@Catch` first and falls back to the global handler. Runs before authentication so
 * the error handler and the controller-instance hook are in place ahead of the auth hook.
 */
export class ErrorHandlingConfigurer extends FeatureConfigurer {
  readonly name = 'error-handling'
  readonly before = ['authentication']

  #global: GlobalErrorHandler | undefined

  configureServer = (ctx: ServerPhaseContext): void => {
    const fastify = ctx.server
    const defaultErrorHandler = fastify.errorHandler
    const errorManager = ctx.services.errorHandling

    // The application-wide error handler. Also the fallback for per-controller (encapsulated) handlers
    // when they do not handle a given error type.
    const globalErrorHandler: GlobalErrorHandler = async (error, request, reply) => {
      const err = error instanceof Error ? error : new Error(String(error))
      const handler = errorManager.handlerFor(err)

      if (handler) {
        await handler.get().handle(request.httpContext, err)
        // The handler renders via ctx; finalize defensively so the request never hangs if it did not.
        if (!reply.sent) {
          return reply.send()
        }

        return
      }

      if (err instanceof ErrHTTP) {
        reply.status(err.statusCode)

        if (err.headers) {
          reply.headers(err.headers)
        }

        const body = err.body !== undefined
          ? err.body
          : { error: err.message, code: err.code, statusCode: err.statusCode, message: err.message }

        return reply.send(body)
      }

      request.log.error({ err }, err.message)

      return defaultErrorHandler(error, request, reply)
    }

    this.#global = globalErrorHandler
    fastify.setErrorHandler(globalErrorHandler)
  }

  configureRouter = (ctx: RouterPhaseContext): void => {
    const server = ctx.server
    const router = ctx.router
    const routes = router.routes
    const controller = router.controller
    const isSingleton = router.binding.scopeID === Scopes.SINGLETON
    const globalErrorHandler = this.#global!

    // A single encapsulated setErrorHandler covers every phase in the plugin (validation, hooks,
    // handler) and resolves, most specific first: the route's @CatchBy, the controller's @CatchBy, a
    // @Catch method on the controller, then the app-wide globalErrorHandler.
    //
    // The @Catch method form needs the controller instance that threw, so when it is in play the
    // instance is resolved once per request in an onRequest hook (inside the live request scope) and
    // reused by the route dispatch — correct for transient scope (no second get()).
    const hasControllerMethodHandlers = !!router.errorHandlers?.size
    const hasScopedHandlers = hasControllerMethodHandlers
      || !!router.catchBy?.size
      || routes.some(route => route.catchBy?.size)

    if (!hasScopedHandlers) {
      return
    }

    const errorHandlers = router.errorHandlers
    const routerCatchBy = router.catchBy

    if (hasControllerMethodHandlers) {
      const ref = isSingleton ? controller.get() : null

      server.addHook('onRequest', (req, _res, done) => {
        req.controller = (ref ?? controller.get()) as Record<string | symbol, unknown>
        done()
      })
    }

    server.setErrorHandler(async (error: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
      const err = error instanceof Error ? error : new Error(String(error))

      // routeOptions is populated before validation, so route-level handlers also see schema errors.
      const routeCatchBy = req.routeOptions.config?.caffeine?.catchBy
      const handler = (routeCatchBy ? resolveByErrorChain(routeCatchBy, err) : undefined)
        ?? (routerCatchBy ? resolveByErrorChain(routerCatchBy, err) : undefined)

      if (handler) {
        await handler.get().handle(req.httpContext, err)
        if (!reply.sent) {
          await reply.send()
        }

        return
      }

      const instance = req.controller
      const methodKey = instance && errorHandlers ? resolveByErrorChain(errorHandlers, err) : undefined

      if (instance && methodKey) {
        const handle = instance[methodKey] as (...args: unknown[]) => unknown
        await handle.apply(instance, [req.httpContext, err])
        if (!reply.sent) {
          await reply.send()
        }

        return
      }

      return globalErrorHandler(error, req, reply)
    })
  }
}

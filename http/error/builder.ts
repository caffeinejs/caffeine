import { Scopes } from '@caffeinejs/di'
import { kFeatureName, type FeatureConfigureKit } from '@caffeinejs/std'
import type { FastifyInstance } from 'fastify'

import { HTTPFeatureBuilder } from '../feature.js'
import { buildCatchByMap, ErrorHandlerProvider, type ErrorHandlerRef } from './handler.js'
import { globalErrorHandlerPlugin, GlobalErrorHandlerRef } from './plugin.js'

/**
 * Configures the error handling every application gets.
 *
 * The feature is registered unconditionally and installs ahead of everything `.with(...)` installs, so every
 * route and hook registered afterwards is covered by it whether or not this is ever called. An application that
 * never calls it renders a thrown `ErrHTTP` as the default JSON envelope and leaves anything else to Fastify.
 *
 * What a call adds is enrolment: which `@Catch` handler classes render errors for the whole application.
 * Declaring a class is no longer enough — a handler nobody named here is still reachable through `@CatchWith`
 * on a controller or route, and nowhere else.
 *
 * ```ts
 * .errorHandling(e => e.globalHandlers(HTTPErrorHandler, FallbackErrorHandler))
 * ```
 *
 * A handler that only applies to some deployments is enrolled by the callback that knows, rather than by a
 * condition on the class — the callback is handed the resolved configuration:
 *
 * ```ts
 * .errorHandling((e, { config }) => { if (config.app.debug) e.globalHandlers(StackTraceHandler) })
 * ```
 */
export class ErrorHandlingBuilder<C = unknown> extends HTTPFeatureBuilder<C> {
  readonly [kFeatureName] = 'error-handling'

  // Built here rather than in `configure`: the server hook reads the same instance, and an application that
  // never configured would otherwise reach it unset.
  readonly #ref = new GlobalErrorHandlerRef()
  readonly #handlers: ErrorHandlerRef[] = []

  /**
   * Enrols handler classes as the application's global error handlers, each rendering the error types its own
   * `@Catch(...)` declares.
   *
   * Accumulates across calls, so several are the same as one. A handler is named by its class, or by the
   * identifier `@Named` gave it.
   *
   * @throws ErrConfiguration at start-up when a handler has no binding, is not decorated with `@Catch`, or
   * handles an error type another enrolled handler already handles.
   */
  globalHandlers(...handlers: ErrorHandlerRef[]): this {
    this.#handlers.push(...handlers)
    return this
  }

  protected override configure(kit: FeatureConfigureKit<C>): void {
    const handlers = buildCatchByMap(kit.container, this.#handlers, {
      owner: 'the application',
      declaredBy: '"globalHandlers"',
    })

    kit.container.bind(ErrorHandlerProvider, t =>
      t
        .toValue(new ErrorHandlerProvider(handlers ?? new Map()))
        .lifetime(Scopes.SINGLETON)
        .internal(),
    )

    kit.container.bind(GlobalErrorHandlerRef, t => t.toValue(this.#ref).lifetime(Scopes.SINGLETON).internal())
  }

  protected override async server(instance: FastifyInstance): Promise<void> {
    await instance.register(globalErrorHandlerPlugin(this.#ref))
  }
}

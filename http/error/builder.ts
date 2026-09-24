import { Scopes } from '@caffeinejs/di'
import { kFeatureName, type BootstrapKit, type FeatureConfigureKit } from '@caffeinejs/std'
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
 * condition on the class — the callback is handed the resolved configuration, which is also how the stack
 * trace is turned on for a development deployment and nowhere else:
 *
 * ```ts
 * .errorHandling((e, { config }) => e.exposeStacktrace(config.app.debug))
 * ```
 */
export class ErrorHandlingBuilder<C = unknown> extends HTTPFeatureBuilder<C> {
  readonly [kFeatureName] = 'error-handling'

  // Built here rather than in `configure`: the server hook reads the same instance, and an application that
  // never configured would otherwise reach it unset.
  readonly #ref = new GlobalErrorHandlerRef()
  readonly #handlers: ErrorHandlerRef[] = []
  #exposeStacktrace = false

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

  /**
   * Sends the stack, and the chain of causes behind it, as `stacktrace` on every error body this package
   * renders — the generic 5xx an unexpected failure answers with, a thrown `ErrHTTP`, and an error naming a
   * public message.
   *
   * Off by default, and meant for a development deployment: a stack names source paths, and a cause names the
   * hosts and driver detail the generic body exists to withhold. A body an `ErrHTTP` carried, anything a
   * `@Catch` handler returned, and the 4xx Fastify renders itself are left alone either way.
   *
   * Turning it on is logged as a warning at start-up, so a deployment that enabled it by accident says so.
   */
  exposeStacktrace(enabled = true): this {
    this.#exposeStacktrace = enabled
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

  protected override bootstrap(kit: BootstrapKit<C>): void {
    if (this.#exposeStacktrace) {
      kit.logger.warn(
        'Error handling is sending stack traces to clients: every error body carries "stacktrace", including ' +
          'the causes behind it. Leave this off outside a development deployment',
      )
    }
  }

  protected override async server(instance: FastifyInstance): Promise<void> {
    await instance.register(globalErrorHandlerPlugin(this.#ref, { exposeStacktrace: this.#exposeStacktrace }))
  }
}

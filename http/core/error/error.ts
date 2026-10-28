import { FeatureBuilder, kFeatureName, type BootstrapKit, type FeatureConfigureKit } from '@caffeinejs/application'
import { Scopes } from '@caffeinejs/di'
import { errMessage } from '@caffeinejs/std/err'

import type { IContext } from '../../context.js'
import { ErrConfiguration } from './common.js'
import { buildCatchByMap, ErrorHandlerProvider, type ErrorHandlerRef } from './handler.js'
import { kErrorHandlingOptions } from './keys.js'
import { defaultProblemFormats, mediaTypeEssence, type ProblemFormat, type ProblemSerializer } from './serializer.js'

/**
 * Where a problem's `correlation_id` comes from, such as the active trace. `undefined` or `''` leaves the member
 * out. Called on the error path, so it is synchronous.
 */
export type CorrelationIDProvider = (ctx: IContext) => string | undefined

const requestID: CorrelationIDProvider = ctx => ctx.req.id

/** What the error-handling feature settled on, for the server's error handler. */
export interface GlobalErrorHandlerOptions {
  /**
   * Sends the stack, and the chain of causes behind it, as `stacktrace` on every problem the error handler renders.
   *
   * Off by default. A body this package did not render — one an `ErrHTTP` carried, anything a `@Catch` handler
   * returned — is left alone either way.
   */
  exposeStacktrace?: boolean
  /**
   * The formats a problem is negotiated among, keyed by their media type's essence. The first is the one a
   * request that names none gets.
   */
  formats?: ReadonlyMap<string, ProblemFormat>
  /** Where `correlation_id` comes from. The request ID by default. */
  correlationID?: CorrelationIDProvider
}

/**
 * Configures the error handling every application gets.
 *
 * The feature is registered unconditionally and installs ahead of everything `.with(...)` installs, so every
 * route and hook registered afterwards is covered by it whether or not this is ever called. An application that
 * never calls it renders every error as an RFC 9457 problem, in the format the request's `Accept` asks for:
 * `application/problem+json`, `text/markdown`, or `application/json` when it names neither.
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
export class ErrorHandlingBuilder<C = unknown> extends FeatureBuilder<C> {
  readonly [kFeatureName] = 'error-handling'

  readonly #handlers: ErrorHandlerRef[] = []
  #exposeStacktrace = false
  readonly #formats = defaultProblemFormats()
  #correlationID = requestID

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
   * public message, and a request Fastify refused.
   *
   * Off by default, and meant for a development deployment: a stack names source paths, and a cause names the
   * hosts and driver detail the generic body exists to withhold. A body an `ErrHTTP` carried and anything a
   * `@Catch` handler returned are left alone either way.
   *
   * Turning it on is logged as a warning at start-up, so a deployment that enabled it by accident says so.
   */
  exposeStacktrace(enabled = true): this {
    this.#exposeStacktrace = enabled
    return this
  }

  /**
   * Renders problems as `mediaType` for a client whose `Accept` asks for it, such as an HTML page for a browser.
   *
   * ```ts
   * .errorHandling(e => e.serializer('text/html', (ctx, problem) => errorPage(problem)))
   * ```
   *
   * Negotiation compares the media type without its parameters, and in any case; the response is sent under
   * `mediaType` as written. A media type already offered, such as `text/markdown`, is replaced. A request whose
   * `Accept` names no format offered still gets `application/json`, so a client never goes without the error.
   *
   * A serializer that throws is logged, and that problem is sent as `application/json` instead.
   *
   * @throws ErrConfiguration when `mediaType` is not a `type/subtype` pair, or holds a wildcard.
   */
  serializer(mediaType: string, serialize: ProblemSerializer): this {
    const essence = mediaTypeEssence(mediaType)

    if (!/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(essence)) {
      throw new ErrConfiguration(
        errMessage(`Cannot serialize problems as "${mediaType}": it is not a media type`)
          .solutions('Pass a type and a subtype without a wildcard, such as "text/html"')
          .reference('@caffeinejs/http', ErrConfiguration)
          .build(),
      )
    }

    this.#formats.set(essence, { mediaType, serialize })
    return this
  }

  /**
   * Takes each problem's `correlation_id` from `provider` instead of the request ID, such as the active trace:
   *
   * ```ts
   * .errorHandling(e => e.correlationID(() => trace.getActiveSpan()?.spanContext().traceId))
   * ```
   *
   * `undefined` or `''` leaves the member out. A provider that throws is logged, and the problem is sent without one.
   */
  correlationID(provider: CorrelationIDProvider): this {
    this.#correlationID = provider
    return this
  }

  protected override configure(kit: FeatureConfigureKit<C>): void {
    // Built when the provider resolves: the handlers are bindings, and nothing is registered while features configure.
    kit.container.bind(ErrorHandlerProvider, t =>
      t
        .toFactory(
          ctx =>
            new ErrorHandlerProvider(
              buildCatchByMap(ctx.container, this.#handlers, {
                owner: 'the application',
                declaredBy: '"globalHandlers"',
              }) ?? new Map(),
            ),
        )
        .lifetime(Scopes.SINGLETON)
        .internal(),
    )

    // What the adapter installs the server's error handler with, ahead of everything `.with(...)` registers.
    kit.container.bind(kErrorHandlingOptions, t =>
      t
        .toValue({
          exposeStacktrace: this.#exposeStacktrace,
          formats: this.#formats,
          correlationID: this.#correlationID,
        })
        .lifetime(Scopes.SINGLETON)
        .internal(),
    )
  }

  protected override bootstrap(kit: BootstrapKit<C>): void {
    if (this.#exposeStacktrace) {
      kit.logger.warn(
        'Error handling is sending stack traces to clients: every error body carries "stacktrace", including ' +
          'the causes behind it. Leave this off outside a development deployment',
      )
    }
  }
}

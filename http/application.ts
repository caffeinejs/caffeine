import type { Container } from '@caffeinejs/di'
import { BaseApplication, type ApplicationInit, type Service, type ShutdownOptions } from '@caffeinejs/std'
import type { FastifyInstance, FastifyRequest } from 'fastify'

import { CacheServiceConfigurer } from './cache/cache_service_configurer.js'
import { ErrConfiguration } from './error/common.js'
import { ErrorHandlerProvider, ErrorHandlingServiceConfigurer } from './error/error.js'
import { solutions } from './error/util.js'
import {
  ErrShutdownTimeout,
  HealthBuilder,
  HealthRegistry,
  HealthServiceConfigurer,
  ProbeEndpoint,
  kHealthContribution,
  loadHealthIndicators,
} from './health/index.js'
import type { HealthServices } from './health/services.js'
import { MiddlewarePipeline, type MiddlewareHook, type MiddlewareRef } from './middleware/index.js'
import type { RouteGroup } from './route.js'
import { ControllerRouteSource } from './routing/decorated/source.js'
import { buildRouting, type RouteSource } from './routing/index.js'
import type { Router } from './routing/programmatic/router.js'
import { FluentRouteSource } from './routing/programmatic/source.js'
import { Authentication } from './security/auth/authentication_middleware.js'
import { kAuthContribution, kOIDCContribution } from './security/auth/keys.js'
import { AuthenticationSchemeProvider } from './security/auth/scheme_provider.js'
import { AuthenticationService } from './security/auth/service.js'
import { ServerOptions, kServerContribution, type ServerAddress } from './server/index.js'
import type { Services } from './service.js'

export interface AdapterIn<R> {
  routeGroups: RouteGroup<R>[]
  services: Services
  middlewares: MiddlewarePipeline
}

export interface Adapter<I, R> {
  get instance(): I

  /** Where the server is listening, or `undefined` before {@link run} and after {@link teardown}. */
  get address(): ServerAddress | undefined

  setup(input: AdapterIn<R>): Promise<void>
  teardown(): Promise<void>
  run(): Promise<void>
  fetch(request: Request | string | URL, options?: RequestInit): Promise<Response>

  /**
   * Abandons whatever is still in flight so a pending {@link teardown} can finish. Called only when the graceful
   * shutdown budget is exhausted, at which point the orchestrator's `SIGKILL` is the alternative. Adapters that
   * cannot force connections shut may leave it undefined.
   */
  forceTeardown?(): Promise<void>
}

export interface AdapterFactoryIn {
  container: Container
}

export type AdapterFactory<I, REQ, A extends Adapter<I, REQ> = Adapter<I, REQ>> = (input: AdapterFactoryIn) => A

/**
 * The HTTP application: a {@link BaseApplication} whose lifecycle steps drive a Fastify {@link Adapter}.
 * `setup()` builds routing + the resolved {@link Services} and sets the adapter up; `start()` runs it;
 * `stop()` tears it down. Base handles the container, services, and lifecycle hooks.
 */
export abstract class AbstractWebApplication<
  I,
  R,
  A extends Adapter<I, R> = Adapter<I, R>,
  ROUTES = never,
> extends BaseApplication {
  /** Phantom — names the routes mounted on this application, for `RoutesOf`. Never assigned, never read. */
  declare readonly __routes?: ROUTES

  readonly #adapter: A
  readonly #middlewares = new MiddlewarePipeline()
  #routeGroups: RouteGroup<R>[] = []
  #mounted: Router<any, any, any, any, any>[] = []
  #built = false
  #health: HealthServices | undefined

  constructor(init: ApplicationInit, adapter: A) {
    super(init)
    this.#adapter = adapter
  }

  get instance(): I {
    return this.#adapter.instance
  }

  /**
   * Where the server is listening, or `undefined` until {@link run} has bound a socket. Reports what the
   * socket actually got, so it is the way to reach an application started on port `0`.
   */
  get address(): ServerAddress | undefined {
    return this.#adapter.address
  }

  get routeGroups(): RouteGroup<R>[] {
    if (!this.started) {
      throw new Error('Application is not ready')
    }

    return this.#routeGroups
  }

  fetch(request: Request | string | URL, options?: RequestInit): Promise<Response> {
    return this.#adapter.fetch(request, options)
  }

  /**
   * Adds a middleware to the request pipeline. Order matters, and it is the order these calls are written
   * in — within a group.
   *
   * `middleware` may be a function, an instance, a middleware class, or a container key; the last two are
   * resolved from the container, so a middleware with dependencies is written as a class and injected like
   * anything else.
   *
   * `hook` defaults to `handler`, which wraps the controller: `next()` returns the handler's result and the
   * middleware may replace it. The four Fastify lifecycle hooks are available for work that must happen
   * before the body is parsed or validated — see {@link MiddlewareHook}, and note that they run in
   * Fastify's order, not in registration order relative to another group.
   *
   * ```ts
   * app.use(RequestLogger)                 // wraps the handler
   * app.use(kRateLimiter, 'onRequest')     // resolved from the container, runs first
   * ```
   *
   * A middleware naming the variables it writes is taken at its word: the routers it ends up in front of are
   * declared elsewhere, so nothing here checks that they declare the same ones.
   */
  use<V, C>(middleware: MiddlewareRef<V, C>, hook: MiddlewareHook = 'handler'): this {
    this.#middlewares.add(middleware, hook)
    return this
  }

  /**
   * Registers authentication — and, with it, authorization — at `onRequest`.
   *
   * The two are one middleware and one call because ordering them is the mistake worth designing out.
   * There is deliberately no `useAuthorization()` to get wrong.
   *
   * An application with protected routes that never calls this fails at start-up rather than serving them
   * unguarded.
   */
  useAuthenticationAndAuthorization(): this {
    return this.use(new Authentication(), 'onRequest')
  }

  protected override configurers(): Service[] {
    return [
      ...this.services,
      new ErrorHandlingServiceConfigurer(),
      new CacheServiceConfigurer(),
      new HealthServiceConfigurer(this.services.some(service => service instanceof HealthBuilder)),
    ]
  }

  /**
   * Mounts programmatic routers, whose routes are then compiled and registered exactly like a controller's.
   *
   * Routing is built once, during start-up, so this has to be called before the application is ready.
   *
   * ```ts
   * app.mount(pets, orders)
   * await app.ready()
   * ```
   *
   * The application comes back carrying the mounted routers' routes in its type, so `RoutesOf<typeof app>` is the
   * whole surface a generated client would call.
   */
  mount<const RS extends ReadonlyArray<Router<any, any, any, any, any>>>(
    ...routers: RS
  ): WebApplication<I, R, A, ROUTES | RoutesOfRouter<RS[number]>>
  mount(...routers: Router<any, any, any, any, any>[]): this {
    if (this.#built) {
      throw new ErrConfiguration(
        'Cannot mount a router: routing has already been built' +
          solutions('Call "mount()" before the application is started'),
      )
    }

    this.#mounted.push(...routers)

    return this
  }

  /**
   * Where routes come from. One source per way of declaring them; a route declared any of those ways is
   * compiled the same and registered the same.
   *
   * The programmatic source is added only when something was mounted, so an application declaring every route
   * with decorators builds exactly what it built before there was a second way.
   */
  protected routeSources(): RouteSource<R>[] {
    const sources: RouteSource<R>[] = [new ControllerRouteSource<R>()]

    if (this.#mounted.length > 0) {
      sources.push(new FluentRouteSource<R>(this.#mounted))
    }

    return sources
  }

  protected override async setup(): Promise<void> {
    this.#routeGroups = buildRouting<R>(this.routeSources(), this.container)
    this.#built = true

    // Copy into a fresh object: the adapter's `listen()` mutates what it receives.
    const server: ServerOptions = { ...this.contributions.get(kServerContribution) }

    const health = this.#buildHealth()
    this.#health = health

    // Configuring authentication binds the coordinator, and nothing else does — so its presence *is* the
    // feature being on, with no separate flag to be written and then read out of sync with it.
    const coordinator = this.container.getOptional(AuthenticationService)

    const services: Services = {
      auth: {
        enabled: coordinator !== undefined,
        coordinator,
        options: this.contributions.find(kAuthContribution),
        schemes: this.container.getOptional(AuthenticationSchemeProvider),
      },
      oidc: this.contributions.find(kOIDCContribution),
      errorHandling: this.container.get(ErrorHandlerProvider),
      server,
      health,
    }

    await this.#adapter.setup({
      routeGroups: this.#routeGroups,
      services,
      middlewares: this.#middlewares,
    })
  }

  protected override start(): Promise<void> {
    return this.#adapter.run()
  }

  /**
   * The drain policy, taken from the resolved health options rather than the builder options — `.health(...)` is
   * the HTTP application's way of configuring it, and wins.
   */
  protected override shutdownOptions(): ShutdownOptions {
    const health = this.#health
    if (health === undefined) {
      return super.shutdownOptions()
    }

    return {
      drainDelayMs: health.options.drainDelayMs,
      shutdownTimeoutMs: health.options.shutdownTimeoutMs,
      signals: health.options.signals,
      dispatcher: health.options.dispatcher,
    }
  }

  /** Drops cached probe evaluations so the first poll after the flip reflects the drain, not the last good run. */
  protected override beforeDrain(): void {
    this.#health?.registry.invalidate()
  }

  /**
   * Tears the adapter down under the shutdown budget. When it expires, connections are forced shut rather than
   * left for the orchestrator's `SIGKILL` — which would arrive moments later and take the rest of the process
   * with it, logs included.
   */
  protected override async stop(): Promise<void> {
    const timeoutMs = this.#health?.options.shutdownTimeoutMs ?? 0
    const teardown = this.#adapter.teardown()

    if (timeoutMs <= 0) {
      return teardown
    }

    // The race subscribes to the teardown, so a rejection arriving after the timeout is still observed.
    const completed = teardown.then(() => 'done' as const)

    let timer: NodeJS.Timeout | undefined
    const expired = new Promise<'timeout'>(resolve => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs)
      timer.unref?.()
    })

    try {
      if ((await Promise.race([completed, expired])) === 'done') {
        return
      }

      await this.#adapter.forceTeardown?.()
      await teardown.catch(() => undefined)

      throw new ErrShutdownTimeout(timeoutMs)
    } finally {
      clearTimeout(timer)
    }
  }

  #buildHealth(): HealthServices {
    const options = this.contributions.get(kHealthContribution)
    const availability = this.availability
    const registry = new HealthRegistry(loadHealthIndicators(this.container), options)

    return { options, availability, registry, probes: new ProbeEndpoint(availability, registry, options) }
  }
}

export class WebApplication<
  I = FastifyInstance,
  R = FastifyRequest,
  A extends Adapter<I, R> = Adapter<I, R>,
  ROUTES = never,
> extends AbstractWebApplication<I, R, A, ROUTES> {}

/** The routes one router declares, distributed so a union of routers folds into a union of their routes. */
type RoutesOfRouter<T> = T extends Router<any, any, any, any, infer R> ? R : never

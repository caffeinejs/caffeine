import type { Container } from '@caffeinejs/di'
import {
  Application,
  type ApplicationInit,
  type Extensions,
  type FeatureLifecycle,
  type RunInfo,
} from '@caffeinejs/std'
import type { FastifyInstance, FastifyRequest } from 'fastify'

import { HTTPCoreFeature } from './core_feature.js'
import { ErrConfiguration } from './error/common.js'
import { ErrorHandlingServiceConfigurer } from './error/error.js'
import { solutions } from './error/util.js'
import { ErrShutdownTimeout, HealthRegistry } from './health/index.js'
import { MiddlewarePipeline, type MiddlewareHook, type MiddlewareRef } from './middleware/index.js'
import type { RouteGroup } from './route.js'
import { ControllerRouteSource } from './routing/decorated/source.js'
import { buildRouting, type RouteSource } from './routing/index.js'
import type { Router } from './routing/programmatic/router.js'
import { FluentRouteSource } from './routing/programmatic/source.js'
import { type ServerAddress } from './server/index.js'

export interface AdapterIn<R> {
  routeGroups: RouteGroup<R>[]
  middlewares: MiddlewarePipeline
  /** What the features registered, in the order they were installed. */
  extensions: Extensions
}

/** {@link RunInfo} widened with where the HTTP server bound. */
export interface WebRunInfo extends RunInfo {
  /**
   * Where the server is listening, from {@link WebApplication.address}. `undefined` only for a bind
   * with no host and port to report: a unix socket, a named pipe, or an adapter that opens no socket. A TCP
   * bind is set by the time {@link WebApplication.run} resolves.
   */
  readonly address: ServerAddress | undefined
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
 * The HTTP application: an {@link Application} whose lifecycle steps drive a Fastify {@link Adapter}.
 * `setup()` builds routing and sets the adapter up; `start()` runs it;
 * `stop()` tears it down. `Application` handles the container, services, and lifecycle hooks.
 */
export class WebApplication<
  I = FastifyInstance,
  R = FastifyRequest,
  A extends Adapter<I, R> = Adapter<I, R>,
  ROUTES = never,
  DEPS = never,
> extends Application {
  /** Phantom — names the routes mounted on this application, for `RoutesOf`. Never assigned, never read. */
  declare readonly __routes?: ROUTES

  /** Phantom — names what the mounted routers injected, for `DepsOf`. Never assigned, never read. */
  declare readonly __deps?: DEPS

  readonly #adapter: A
  readonly #middlewares = new MiddlewarePipeline()
  #routeGroups: RouteGroup<R>[] = []
  #mounted: Router<any, any, any, any, any>[] = []
  #built = false

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

  protected override configurers(): FeatureLifecycle[] {
    // Error handling leads, so its `core` extension is the first thing registered on the server and every
    // route and hook the rest register is already covered by it.
    return [new ErrorHandlingServiceConfigurer(), ...this.services, new HTTPCoreFeature()]
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
  ): WebApplication<I, R, A, ROUTES | RoutesOfRouter<RS[number]>, DEPS | DepsOfRouter<RS[number]>>
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

    await this.#adapter.setup({
      routeGroups: this.#routeGroups,
      middlewares: this.#middlewares,
      extensions: this.extensions,
    })
  }

  protected override start(): Promise<void> {
    return this.#adapter.run()
  }

  protected override runInfo(): WebRunInfo {
    return { ...super.runInfo(), address: this.address }
  }

  override run(): Promise<WebRunInfo> {
    // runInfo() is overridden, so what base run() resolves to is already a WebRunInfo.
    return super.run() as Promise<WebRunInfo>
  }

  /** Drops cached probe evaluations so the first poll after the flip reflects the drain, not the last good run. */
  protected override beforeDrain(): void {
    this.container.getOptional(HealthRegistry)?.invalidate()
  }

  /**
   * Tears the adapter down under the shutdown budget. When it expires, connections are forced shut rather than
   * left for the orchestrator's `SIGKILL` — which would arrive moments later and take the rest of the process
   * with it, logs included.
   */
  protected override async stop(): Promise<void> {
    const timeoutMs = this.shutdownOptions().shutdownTimeoutMs
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
}

/** The routes one router declares, distributed so a union of routers folds into a union of their routes. */
type RoutesOfRouter<T> = T extends Router<any, any, any, any, infer R> ? R : never

/**
 * What one router injected, distributed the same way — `DepsOf` intersects the union back into one bag.
 *
 * A router that injected nothing carries `undefined` rather than `never`, and unioning that in would make every
 * application that mounted one report `undefined` as its dependencies. It contributes nothing instead.
 */
type DepsOfRouter<T> = T extends Router<any, any, infer D, any, any> ? (D extends undefined ? never : D) : never

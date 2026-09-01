import type { Container } from '@caffeinejs/di'
import { BaseApplication, type ApplicationInit, type Service, type ShutdownOptions } from '@caffeinejs/std'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Router } from './route.js'
import type { Services } from './service.js'
import { MiddlewarePipeline, type MiddlewareHook, type MiddlewareRef } from './middleware/index.js'
import { buildRouting, type RouteSource } from './routing/index.js'
import { ControllerRouteSource } from './decorators/registrar/source.js'
import { Authentication } from './security/auth/authentication_middleware.js'
import { AuthenticationSchemeProvider } from './security/auth/scheme_provider.js'
import { AuthenticationService } from './security/auth/service.js'
import { kAuthContribution, kOIDCContribution } from './security/auth/keys.js'
import { ErrorHandlerProvider, ErrorHandlingServiceConfigurer } from './error/error.js'
import { CacheServiceConfigurer } from './cache/cache_service_configurer.js'
import { ServerOptions, kServerContribution, type ServerAddress } from './server/index.js'
import { ErrShutdownTimeout, HealthBuilder, HealthRegistry, HealthServiceConfigurer, ProbeEndpoint, kHealthContribution, loadHealthIndicators } from './health/index.js'
import type { HealthServices } from './health/services.js'

export interface AdapterIn<R> {
  routers: Router<R>[]
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

export type AdapterFactory<I, REQ, A extends Adapter<I, REQ> = Adapter<I, REQ>>
  = (input: AdapterFactoryIn) => A

/**
 * The HTTP application: a {@link BaseApplication} whose lifecycle steps drive a Fastify {@link Adapter}.
 * `setup()` builds routing + the resolved {@link Services} and sets the adapter up; `start()` runs it;
 * `stop()` tears it down. Base handles the container, services, and lifecycle hooks.
 */
export abstract class AbstractWebApplication<I, R, A extends Adapter<I, R> = Adapter<I, R>> extends BaseApplication {
  readonly #adapter: A
  readonly #middlewares = new MiddlewarePipeline()
  #routers: Router<R>[] = []
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

  get routers(): Router<R>[] {
    if (!this.started) {
      throw new Error('Application is not ready')
    }

    return this.#routers
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
   */
  use(middleware: MiddlewareRef, hook: MiddlewareHook = 'handler'): this {
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
   * Where routes come from. One source per way of declaring them; a route declared any of those ways is
   * compiled the same and registered the same.
   */
  protected routeSources(): RouteSource<R>[] {
    return [new ControllerRouteSource<R>()]
  }

  protected override async setup(): Promise<void> {
    this.#routers = buildRouting<R>(this.routeSources(), this.container)

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
      routers: this.#routers,
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
      if (await Promise.race([completed, expired]) === 'done') {
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
> extends AbstractWebApplication<I, R, A> {}

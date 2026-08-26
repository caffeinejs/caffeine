import type { Container } from '@caffeinejs/di'
import { BaseApplication, HealthIndicator, type ApplicationInit, type Service, type ShutdownOptions } from '@caffeinejs/std'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Router } from './route.js'
import { Feats } from './feats.js'
import type { ServiceKit, Services } from './service.js'
import { MiddlewarePipeline, type MiddlewareHook, type MiddlewareRef } from './middleware/index.js'
import { buildRouting } from './routing/index.js'
import { Authentication } from './security/auth/authentication_middleware.js'
import { AuthenticationSchemeProvider } from './security/auth/scheme_provider.js'
import { AuthenticationService } from './security/auth/service.js'
import { kAuthOpts, kOIDCMeta } from './security/auth/keys.js'
import type { OIDCMeta } from './security/auth/oidc/index.js'
import { ErrorHandlerProvider, ErrorHandlingServiceConfigurer } from './error/error.js'
import { CacheServiceConfigurer } from './cache/cache_service_configurer.js'
import { DEFAULT_SERVER_OPTIONS, ServerOptions, kServerOptions } from './server/index.js'
import { ErrShutdownTimeout, HealthRegistry, HealthServiceConfigurer, ProbeEndpoint, kHealthOptions, type HealthOptions } from './health/index.js'
import type { HealthServices } from './health/services.js'

export interface AdapterIn<R> {
  routers: Router<R>[]
  feats: Feats
  services: Services
  middlewares: MiddlewarePipeline
}

export interface Adapter<I, R> {
  get instance(): I

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
  readonly #feats = new Feats()
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
   * The two are one middleware and one call because ordering them is the mistake worth designing out: in
   * ASP.NET Core, `UseAuthorization` before `UseAuthentication` authorizes an identity nothing has
   * established yet. There is deliberately no `useAuthorization()` to get wrong.
   *
   * An application with protected routes that never calls this fails at start-up rather than serving them
   * unguarded.
   */
  useAuthenticationAndAuthorization(): this {
    return this.use(new Authentication(), 'onRequest')
  }

  protected override serviceKit(): ServiceKit {
    return { container: this.container, availability: this.availability, feats: this.#feats }
  }

  protected override configurers(): Service[] {
    return [
      ...this.services,
      new ErrorHandlingServiceConfigurer(),
      new CacheServiceConfigurer(),
      new HealthServiceConfigurer(),
    ]
  }

  protected override async setup(): Promise<void> {
    this.#routers = buildRouting<R>(this.container)

    // Copy into a fresh object: the adapter's `listen()` mutates what it receives, which would otherwise
    // corrupt the shared DEFAULT_SERVER_OPTIONS when the server builder was never used.
    const serverOptions = this.container.getOptional<ServerOptions>(kServerOptions) ?? DEFAULT_SERVER_OPTIONS
    const server: ServerOptions = { ...serverOptions }

    const health = this.#buildHealth()
    this.#health = health

    const services: Services = {
      auth: {
        enabled: this.#feats.authentication,
        coordinator: this.container.getOptional(AuthenticationService),
        options: this.container.getOptional(kAuthOpts),
        schemes: this.container.getOptional(AuthenticationSchemeProvider),
      },
      oidc: this.container.getOptional<OIDCMeta>(kOIDCMeta),
      errorHandling: this.container.get(ErrorHandlerProvider),
      server,
      health,
    }

    await this.#adapter.setup({
      routers: this.#routers,
      feats: this.#feats,
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
    const options = this.container.get<HealthOptions>(kHealthOptions)
    const availability = this.availability
    const registry = new HealthRegistry(this.container.getManyOptional(HealthIndicator), options)

    return { options, availability, registry, probes: new ProbeEndpoint(availability, registry, options) }
  }
}

export class WebApplication<
  I = FastifyInstance,
  R = FastifyRequest,
  A extends Adapter<I, R> = Adapter<I, R>,
> extends AbstractWebApplication<I, R, A> {}

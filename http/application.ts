import type { Container } from '@caffeinejs/di'
import { BaseApplication, type ApplicationInit, type Service } from '@caffeinejs/std'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Router } from './route.js'
import { Feats } from './feats.js'
import type { ServiceKit, Services } from './service.js'
import { buildRouting } from './routing/routing.js'
import { AuthenticationService } from './security/auth/service.js'
import { kAuthOpts, kOIDCMeta } from './security/auth/keys.js'
import type { OIDCMeta } from './security/auth/oidc/index.js'
import { ErrorHandlerProvider, ErrorHandlingServiceConfigurer } from './error/error.js'
import { CacheServiceConfigurer } from './cache/cache_service_configurer.js'
import { DEFAULT_SERVER_OPTIONS, ServerOptions, kServerOptions } from './server/index.js'

export interface AdapterIn<R> {
  routers: Router<R>[]
  feats: Feats
  services: Services
}

export interface Adapter<I, R> {
  get instance(): I

  setup(input: AdapterIn<R>): Promise<void>
  teardown(): Promise<void>
  run(): Promise<void>
  fetch(request: Request | string | URL, options?: RequestInit): Promise<Response>
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
  #routers: Router<R>[] = []

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

  protected override serviceKit(): ServiceKit {
    return { container: this.container, feats: this.#feats }
  }

  protected override configurers(): Service[] {
    return [...this.services, new ErrorHandlingServiceConfigurer(), new CacheServiceConfigurer()]
  }

  protected override async setup(): Promise<void> {
    this.#routers = buildRouting<R>(this.container)

    // Copy into a fresh object: the adapter's `listen()` mutates what it receives, which would otherwise
    // corrupt the shared DEFAULT_SERVER_OPTIONS when the server builder was never used.
    const serverOptions = this.container.getOptional<ServerOptions>(kServerOptions) ?? DEFAULT_SERVER_OPTIONS
    const server: ServerOptions = { ...serverOptions }

    const services: Services = {
      auth: {
        enabled: this.#feats.authentication,
        coordinator: this.container.getOptional(AuthenticationService),
        options: this.container.getOptional(kAuthOpts),
      },
      oidc: this.container.getOptional<OIDCMeta>(kOIDCMeta),
      errorHandling: this.container.get(ErrorHandlerProvider),
      server,
    }

    await this.#adapter.setup({ routers: this.#routers, feats: this.#feats, services })
  }

  protected override start(): Promise<void> {
    return this.#adapter.run()
  }

  protected override stop(): Promise<void> {
    return this.#adapter.teardown()
  }
}

export class WebApplication<
  I = FastifyInstance,
  R = FastifyRequest,
  A extends Adapter<I, R> = Adapter<I, R>,
> extends AbstractWebApplication<I, R, A> {}

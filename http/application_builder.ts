import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  AppConfigBuilder,
  BaseApplicationBuilder,
  type ApplicationBuilderOptions,
  type Reconfigured,
} from '@caffeinejs/std'
import type { ConfigSchema, InferConfig } from '@caffeinejs/std/config'
import { AdapterFactory, WebApplication, type Adapter } from './application.js'
import { FastifyAdapter } from './adapter.js'
import { fastifyAdapterFactory } from './adapter_factory.js'
import { AuthenticationBuilder } from './security/auth/builder.js'
import { AuthorizationBuilder } from './security/authz/index.js'
import { CacheBuilder } from './cache/cache_builder.js'
import { ServerBuilder } from './server/index.js'
import { HealthBuilder } from './health/health_builder.js'

export type WebApplicationBuilderOptions = ApplicationBuilderOptions

export class WebApplicationBuilder<I, REQ, A extends Adapter<I, REQ> = Adapter<I, REQ>, TConfig = unknown>
  extends BaseApplicationBuilder<WebApplication<I, REQ, A>> {
  readonly #adapterFactory: AdapterFactory<I, REQ, A>

  #authBuilder: AuthenticationBuilder | undefined
  #cacheBuilder: CacheBuilder | undefined
  #healthBuilder: HealthBuilder<unknown> | undefined
  readonly #authzBuilder: AuthorizationBuilder
  readonly #serverBuilder: ServerBuilder<unknown>

  constructor(adapterFactory: AdapterFactory<I, REQ, A>, options: WebApplicationBuilderOptions = {}) {
    super(options)
    this.#adapterFactory = adapterFactory

    this.#authzBuilder = new AuthorizationBuilder()
    this.addService(this.#authzBuilder)

    // Registered unconditionally: the listen address is read from the configuration tree, so `SERVER__PORT`
    // has to work on an application that never calls `.server()`.
    this.#serverBuilder = new ServerBuilder<unknown>()
    this.addService(this.#serverBuilder)
  }

  authentication(configure: (auth: AuthenticationBuilder) => void): this {
    if (this.#authBuilder == null) {
      this.#authBuilder = new AuthenticationBuilder()
      this.addService(this.#authBuilder)
    }

    configure(this.#authBuilder)

    return this
  }

  authorization(configure: (authz: AuthorizationBuilder) => void): this {
    configure(this.#authzBuilder)
    return this
  }

  cache(configure: (cache: CacheBuilder) => void): this {
    if (this.#cacheBuilder == null) {
      this.#cacheBuilder = new CacheBuilder()
      this.addService(this.#cacheBuilder)
    }

    configure(this.#cacheBuilder)

    return this
  }

  /**
   * Declares the application configuration and re-types the builder to carry the config type `T` (inferred from
   * `schema`), so features configured afterwards (e.g. `server(s => s.config(c => c.server))`) see a
   * strongly-typed `ConfigHandle<T>`. The optional `configure` callback — any shape — adds sources and context.
   * Declare it first. Runtime returns the same instance; only the declared type changes.
   */
  config(configure: (c: AppConfigBuilder<TConfig>) => void): this
  config<S extends ConfigSchema>(
    schema: S,
    configure?: (c: AppConfigBuilder<InferConfig<S>>) => void,
  ): Reconfigured<
    this,
    WebApplicationBuilder<I, REQ, A>,
    WebApplicationBuilder<I, REQ, A, InferConfig<S>>
  >
  config<S extends ConfigSchema>(
    first: S | ((c: AppConfigBuilder<TConfig>) => void),
    second?: (c: AppConfigBuilder<InferConfig<S>>) => void,
  ): unknown {
    this.applyConfigArgs(first as S, second as never)
    return this
  }

  /**
   * Enables the Kubernetes probes (`/livez`, `/readyz`, `/startupz`) and the graceful shutdown that drives them.
   * Calling it with no configuration is a complete setup; see {@link HealthBuilder} for what the defaults are.
   *
   * Left uncalled, the probes are exposed only when `KUBERNETES_SERVICE_HOST` is present — but the drain sequence
   * and the signal handlers are installed either way, because dropping in-flight requests on shutdown is not a
   * behaviour anyone opts into deliberately.
   */
  health(configure?: (health: HealthBuilder<TConfig>) => void): this {
    if (this.#healthBuilder == null) {
      this.#healthBuilder = new HealthBuilder<unknown>()
      this.addService(this.#healthBuilder)
    }

    configure?.(this.#healthBuilder as HealthBuilder<TConfig>)

    return this
  }

  server(configure: (server: ServerBuilder<TConfig>) => void): this {
    configure(this.#serverBuilder as ServerBuilder<TConfig>)
    return this
  }

  build(): WebApplication<I, REQ, A> {
    const adapter = this.#adapterFactory({ container: this.container })
    return new WebApplication<I, REQ, A>(this.applicationInit(), adapter)
  }
}

/**
 * Creates a web application builder.
 *
 * Install plugins with `.extend(...)` rather than here: it is typed the same way, and it can be called at
 * any point in the chain — including after `.config()`, which re-types the builder and would otherwise drop
 * the plugins' methods.
 *
 * ```ts
 * createWebApplication()
 *   .extend(viewPlugin(), staticPlugin())
 *   .view(v => v.engine({ handlebars }))
 * ```
 */
// Default Fastify — no adapter factory or Fastify instance required.
export function createWebApplication(
  options?: WebApplicationBuilderOptions,
): WebApplicationBuilder<FastifyInstance, FastifyRequest, FastifyAdapter<FastifyInstance, FastifyRequest>>
// Explicit adapter factory — a customized Fastify instance (`fastifyAdapterFactory(myFastify)`) or a
// custom adapter altogether.
export function createWebApplication<I, REQ, A extends Adapter<I, REQ> = Adapter<I, REQ>>(
  adapterFactory: AdapterFactory<I, REQ, A>,
  options?: WebApplicationBuilderOptions,
): WebApplicationBuilder<I, REQ, A>
export function createWebApplication(
  first?: AdapterFactory<any, any> | WebApplicationBuilderOptions,
  second?: WebApplicationBuilderOptions,
): WebApplicationBuilder<any, any> {
  return typeof first === 'function'
    ? new WebApplicationBuilder(first, second ?? {})
    : new WebApplicationBuilder(fastifyAdapterFactory(), first ?? {})
}

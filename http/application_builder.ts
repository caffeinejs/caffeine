import type { NamedToken } from '@caffeinejs/di'
import {
  AppConfigBuilder,
  BaseApplicationBuilder,
  ShutdownBuilder,
  type ApplicationBuilderOptions,
  type ApplicationConfigMarker,
  type Reconfigured,
} from '@caffeinejs/std'
import type { ConfigHandle, ConfigSchema, InferConfig } from '@caffeinejs/std/config'
import type { FastifyInstance, FastifyRequest } from 'fastify'

import { FastifyAdapter } from './adapter.js'
import { fastifyAdapterFactory } from './adapter_factory.js'
import { AdapterFactory, WebApplication, type Adapter } from './application.js'
import { CacheBuilder } from './cache/cache_builder.js'
import { ConstraintsBuilder } from './constraints/builder.js'
import { GuardsBuilder } from './guards/builder.js'
import { HealthBuilder } from './health/health_builder.js'
import { AuthenticationBuilder } from './security/auth/builder.js'
import { AuthenticationConfigurer } from './security/authentication_configurer.js'
import { AuthorizationBuilder } from './security/authz/index.js'
import { ServerBuilder } from './server/index.js'

export type WebApplicationBuilderOptions = ApplicationBuilderOptions

export class WebApplicationBuilder<I, REQ, A extends Adapter<I, REQ> = Adapter<I, REQ>, TConfig = unknown>
  extends BaseApplicationBuilder<WebApplication<I, REQ, A>>
  implements ApplicationConfigMarker<TConfig>
{
  /** Phantom — names the application config type for `ConfigTypeOf`. Never assigned, never read. */
  declare readonly __config?: TConfig

  readonly #adapterFactory: AdapterFactory<I, REQ, A>

  #authBuilder: AuthenticationBuilder | undefined
  #cacheBuilder: CacheBuilder<unknown> | undefined
  readonly #authzBuilder: AuthorizationBuilder
  readonly #serverBuilder: ServerBuilder<unknown>
  readonly #healthBuilder: HealthBuilder<unknown>
  readonly #shutdownBuilder: ShutdownBuilder<unknown>
  readonly #guardsBuilder: GuardsBuilder
  readonly #constraintsBuilder: ConstraintsBuilder

  constructor(adapterFactory: AdapterFactory<I, REQ, A>, options: WebApplicationBuilderOptions = {}) {
    super(options)
    this.#adapterFactory = adapterFactory

    this.#authzBuilder = new AuthorizationBuilder()
    this.addFeature(this.#authzBuilder)

    // Registered unconditionally: the authentication extension is what refuses an application that protects a
    // route and never called `.authentication(...)`, so it has to run even when nothing configured it.
    this.addFeature(new AuthenticationConfigurer())

    this.#guardsBuilder = new GuardsBuilder()
    this.addFeature(this.#guardsBuilder)

    // Registered unconditionally: `version` route selection and the `Vary` header work without a `.constraints()`
    // call, and the compiler always resolves route constraints against the bound registry.
    this.#constraintsBuilder = new ConstraintsBuilder()
    this.addFeature(this.#constraintsBuilder)

    // Registered unconditionally: the listen address is read from the configuration tree, so `SERVER__PORT`
    // has to work on an application that never calls `.server()`.
    this.#serverBuilder = new ServerBuilder<unknown>()
    this.addFeature(this.#serverBuilder)

    // Likewise: `HEALTH__ENABLED=true` has to switch the probes on without a code change. `.health()` only
    // flips the default for `enabled`.
    this.#healthBuilder = new HealthBuilder<unknown>()
    this.addFeature(this.#healthBuilder)

    // The drain sequence and its signal handlers apply to every application, probes or not, so
    // `SHUTDOWN__DRAIN_DELAY` has to work on one that never calls `.shutdown()`.
    this.#shutdownBuilder = new ShutdownBuilder<unknown>()
    this.addFeature(this.#shutdownBuilder)
  }

  authentication(configure: (auth: AuthenticationBuilder<TConfig>) => void): this {
    if (this.#authBuilder == null) {
      this.#authBuilder = new AuthenticationBuilder()
      this.addFeature(this.#authBuilder)
    }

    configure(this.#authBuilder as AuthenticationBuilder<TConfig>)

    return this
  }

  authorization(configure: (authz: AuthorizationBuilder) => void): this {
    configure(this.#authzBuilder)
    return this
  }

  /**
   * Lists the container Keys of guards that run on every route, in registration order, before
   * controller- and method-level `@UseGuards`.
   *
   * Does not bind the classes. Each Key must already be a container-managed Guard.
   * Calling this is not required for `@UseGuards` on controllers.
   *
   * ```ts
   * createWebApplication()
   *   .guards(g => g.global(RolesGuard, kNamedAuthGuard))
   * ```
   */
  guards(configure: (guards: GuardsBuilder) => void): this {
    configure(this.#guardsBuilder)
    return this
  }

  /**
   * Registers custom route-selection constraint strategies, so a route selects on them with
   * `@Constraint(name, value)` or `.constraint(name, value)`.
   *
   * `version` is available without this — it is Fastify's built-in semver matcher on `Accept-Version`.
   *
   * ```ts
   * createWebApplication()
   *   .constraints(c => c.register(tenantConstraint, { header: 'X-Tenant' }))
   * ```
   */
  constraints(configure: (constraints: ConstraintsBuilder) => void): this {
    configure(this.#constraintsBuilder)
    return this
  }

  cache(configure: (cache: CacheBuilder<TConfig>) => void): this {
    if (this.#cacheBuilder == null) {
      this.#cacheBuilder = new CacheBuilder()
      this.addFeature(this.#cacheBuilder)
    }

    configure(this.#cacheBuilder as CacheBuilder<TConfig>)

    return this
  }

  /**
   * Declares the application configuration — the schema it is validated against, and the key its resolved
   * `ConfigHandle` is bound under — and re-types the builder to carry the config type `T` (inferred from
   * `schema`), so features configured afterwards (e.g. `server(s => s.config(c => c.server))`) see a
   * strongly-typed `ConfigHandle<T>`. The optional `configure` callback — any shape — adds sources and context.
   * Declare it first. Runtime returns the same instance; only the declared type changes.
   *
   * The key may name a **wider** type than the schema describes. A feature's namespace is in the resolved tree
   * whether or not the application declared it, so naming `server` in the key's type without redeclaring its
   * shape is accurate rather than a lie.
   *
   * ```ts
   * const kConfig = token<ConfigHandle<AppConfig>>(Symbol('app.config'))
   *
   * createWebApplication().config(schema, kConfig, c => c.source(new EnvConfigProvider()))
   * ```
   */
  config<S extends ConfigSchema, T extends InferConfig<NoInfer<S>> = InferConfig<NoInfer<S>>>(
    schema: S,
    key: NamedToken<ConfigHandle<T>>,
    configure?: (c: AppConfigBuilder<T>) => void,
  ): Reconfigured<this, WebApplicationBuilder<I, REQ, A>, WebApplicationBuilder<I, REQ, A, T>> {
    this.applyConfigDefinition<T>(schema as ConfigSchema<unknown>, key, configure)
    return this as never
  }

  /**
   * Enables the Kubernetes probes (`/livez`, `/readyz`, `/startupz`). Calling it with no configuration is a
   * complete setup; see {@link HealthBuilder} for what the defaults are.
   *
   * Left uncalled, the probes are exposed only when `KUBERNETES_SERVICE_HOST` is present. Graceful shutdown —
   * the drain sequence and the signal handlers — is a separate feature; configure it with {@link shutdown}.
   */
  health(configure?: (health: HealthBuilder<TConfig>) => void): this {
    // The feature is already registered; reaching this is what turns the probes on regardless of environment.
    this.#healthBuilder.markExplicit()
    configure?.(this.#healthBuilder as HealthBuilder<TConfig>)

    return this
  }

  /**
   * Configures graceful shutdown: the drain delay, the teardown budget, the signals that trigger it, and the
   * dispatcher that delivers them. The feature is registered either way, so this only overrides the defaults —
   * `s.drainDelay('5s')` is a **default** that `SHUTDOWN__DRAIN_DELAY` or the config tree can still redirect.
   */
  shutdown(configure: (shutdown: ShutdownBuilder<TConfig>) => void): this {
    configure(this.#shutdownBuilder as ShutdownBuilder<TConfig>)
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
 * Install features with `.extend(feature, configure)` rather than here: it can be called at any point in
 * the chain, including after `.config()`.
 *
 * ```ts
 * createWebApplication()
 *   .extend(ViewExt(), v => v.engine({ handlebars }))
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

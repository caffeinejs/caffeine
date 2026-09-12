import type { InjectionToken, NamedToken } from '@caffeinejs/di'
import {
  AppConfigBuilder,
  BaseApplicationBuilder,
  ShutdownBuilder,
  kAddConfigurer,
  type ApplicationBuilderOptions,
  type ApplicationConfigMarker,
  type FeatureConfigurer,
  type Reconfigured,
} from '@caffeinejs/std'
import type { ConfigHandle, ConfigSchema, InferConfig } from '@caffeinejs/std/config'
import type { FastifyInstance, FastifyRequest } from 'fastify'

import { FastifyAdapter } from './adapter.js'
import { fastifyAdapterFactory } from './adapter_factory.js'
import { AdapterFactory, WebApplication, type Adapter } from './application.js'
import { ConstraintsBuilder } from './constraints/builder.js'
import { GuardsBuilder } from './guards/builder.js'
import { HealthBuilder } from './health/health_builder.js'
import { asPluginFactory, type HTTPPluginFactory, type HTTPPluginProvider } from './plugin.js'
import { HTTPPluginFeature } from './plugin_feature.js'
import { AuthenticationBuilder } from './security/auth/builder.js'
import { AuthorizationBuilder } from './security/authz/index.js'
import { ServerBuilder } from './server/index.js'

export type WebApplicationBuilderOptions = ApplicationBuilderOptions

export class WebApplicationBuilder<I, REQ, A extends Adapter<I, REQ> = Adapter<I, REQ>, TConfig = unknown>
  extends BaseApplicationBuilder<WebApplication<I, REQ, A, never, never, TConfig>>
  implements ApplicationConfigMarker<TConfig>
{
  /** Phantom — names the application config type for `ConfigTypeOf`. Never assigned, never read. */
  declare readonly __config?: TConfig

  readonly #adapterFactory: AdapterFactory<I, REQ, A>

  #authBuilder: AuthenticationBuilder | undefined
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

    this.#guardsBuilder = new GuardsBuilder()
    this.addFeature(this.#guardsBuilder)

    // Registered unconditionally: `version` route selection and the `Vary` header work without a `.constraints()`
    // call, and the compiler always resolves route constraints against the bound registry.
    this.#constraintsBuilder = new ConstraintsBuilder()
    this.addFeature(this.#constraintsBuilder)

    // Registered unconditionally: every application has a listen address. Configuration reaches it only
    // through `.server((s, c) => s.withConfig(...))` — declaring `server` in the schema is not enough.
    this.#serverBuilder = new ServerBuilder<unknown>()
    this.addFeature(this.#serverBuilder)

    // Likewise: the probes exist whether or not `.health()` is called. Calling it opts in regardless of
    // environment; leaving it uncalled enables them only on Kubernetes. `HEALTH__ENABLED` reaches the
    // feature only through `.health((h, c) => h.withConfig(...))`.
    this.#healthBuilder = new HealthBuilder<unknown>()
    this.addFeature(this.#healthBuilder)

    // The drain sequence and its signal handlers apply to every application, probes or not. Configuration
    // reaches it only through `.shutdown((s, c) => s.withConfig(...))`.
    this.#shutdownBuilder = new ShutdownBuilder<unknown>()
    this.addFeature(this.#shutdownBuilder)
  }

  /**
   * Registers a Fastify plugin, or resolves an {@link HTTPPluginProvider} from the container and registers
   * what it creates.
   *
   * A factory is a function; a token is a class, a `token(...)`, or a `DeferredCtor`. Both take their
   * position in the same list as `.extend(feature)` and `.authentication(...)`, so they register in the
   * order these calls are written:
   *
   * ```ts
   * createWebApplication()
   *   .plugin(c => corsPlugin(c.app.cors.options))
   *   .extend(caching(cache => cache.ttl('5m')))
   * ```
   *
   * Write the factory as an arrow: a `function` declaration is constructable and would be taken as a class
   * token. An unnamed plugin is never deduplicated — two calls register two plugins. A `fastify-plugin` name
   * already on that instance is refused at register time.
   */
  plugin(factory: HTTPPluginFactory<TConfig>): this
  plugin(key: InjectionToken<HTTPPluginProvider<TConfig>>): this
  plugin(target: HTTPPluginFactory<TConfig> | InjectionToken<HTTPPluginProvider<TConfig>>): this {
    return this.addFeature(new HTTPPluginFeature(asPluginFactory(target)))
  }

  /**
   * Configures authentication, and puts the gate where this call is written.
   *
   * The `onRequest` hook that authenticates and authorizes registers at this position among the plugins, so a
   * feature or plugin registered before this call runs ahead of it — `cors()`, whose headers a rejected cross-origin
   * request still needs — and one registered after it never runs for a request the gate rejected.
   */
  authentication(configure: FeatureConfigurer<AuthenticationBuilder<TConfig>, TConfig>): this {
    if (this.#authBuilder == null) {
      this.#authBuilder = new AuthenticationBuilder()
      this.addFeature(this.#authBuilder)
    }

    this.#authBuilder[kAddConfigurer](configure as never)

    return this
  }

  /**
   * Configures authorization. Runs immediately: there is nothing to read from the configuration tree, so
   * there is no `(a, c)` callback and nothing is queued for bootstrap — unlike `.server((s, c) => …)`.
   */
  authorization(configure: (authz: AuthorizationBuilder) => void): this {
    configure(this.#authzBuilder)
    return this
  }

  /**
   * Lists the container Keys of guards that run on every route, in registration order, before
   * controller- and method-level `@UseGuards`.
   *
   * Runs immediately: guards have nothing to read from the configuration tree, so there is no `(g, c)`
   * callback and nothing is queued for bootstrap — unlike `.server((s, c) => …)`.
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
   * Runs immediately: strategies have nothing to read from the configuration tree, so there is no `(c, config)`
   * callback and nothing is queued for bootstrap — unlike `.server((s, c) => …)`.
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

  /**
   * Declares the application configuration — the schema it is validated against, and the key its resolved
   * `ConfigHandle` is bound under — and re-types the builder to carry the config type `T` (inferred from
   * `schema`), so features configured afterwards (e.g. `server((s, c) => s.withConfig(c.server))`) see a
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
  health(configure?: FeatureConfigurer<HealthBuilder<TConfig>, TConfig>): this {
    // The feature is already registered; reaching this is what turns the probes on regardless of environment.
    this.#healthBuilder.markExplicit()
    if (configure !== undefined) {
      this.#healthBuilder[kAddConfigurer](configure as never)
    }

    return this
  }

  /**
   * Configures graceful shutdown: the drain delay, the teardown budget, the signals that trigger it, and the
   * dispatcher that delivers them. The feature is registered either way, so this only overrides the defaults.
   * A fluent method is the last word; `SHUTDOWN__DRAIN_DELAY` reaches the feature only through
   * `.shutdown((s, c) => s.withConfig(c.shutdown))`.
   */
  shutdown(configure: FeatureConfigurer<ShutdownBuilder<TConfig>, TConfig>): this {
    this.#shutdownBuilder[kAddConfigurer](configure as never)
    return this
  }

  server(configure: FeatureConfigurer<ServerBuilder<TConfig>, TConfig>): this {
    this.#serverBuilder[kAddConfigurer](configure as never)
    return this
  }

  build(): WebApplication<I, REQ, A, never, never, TConfig> {
    const adapter = this.#adapterFactory({ container: this.container })
    return new WebApplication<I, REQ, A, never, never, TConfig>(this.applicationInit(), adapter)
  }
}

/**
 * Creates a web application builder.
 *
 * Install features with `.extend(feature)` or `.extend(feature(configure))` rather than here: it can be
 * called at any point in the chain, including after `.config()`. A plugin factory is
 * `.plugin(c => corsPlugin(c.app.cors.options))`.
 *
 * ```ts
 * createWebApplication()
 *   .extend(view(v => v.engine(e => e.engine({ handlebars }))))
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

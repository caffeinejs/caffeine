import { CaffeineIoC, type Container, type Module, type ModuleFn, type NamedToken, type Options } from '@caffeinejs/di'

import { AppConfigBuilder } from './app_config.js'
import { Application, type ApplicationInit, type BaseApplication } from './application.js'
import {
  ConfigDefinition,
  ConfigModule,
  kConfigDefinition,
  type ConfigHandle,
  type ConfigLocation,
  type ConfigSchema,
  type InferConfig,
} from './config/index.js'
import { ErrFeatureAlreadyInstalled, type Feature, type FeatureLifecycle, type PluginContext } from './feature.js'
import type { FeatureBuilder } from './feature_builder.js'
import { ShutdownBuilder } from './shutdown/shutdown_builder.js'
import { detectSignalDispatcher } from './shutdown/signals.js'

export interface ApplicationBuilderOptions {
  container?: Container | Options
}

/**
 * Platform-neutral builder foundation: owns container creation, the {@link Service} list, and the feature
 * install surface. Concrete builders (headless {@link ApplicationBuilder}, the HTTP `WebApplicationBuilder`)
 * extend it and implement {@link build}.
 *
 * The builder constructs the container with `decorators:false` and calls `autoWire()`; a caller-supplied,
 * already-wired container is used as-is.
 */
export abstract class BaseApplicationBuilder<App extends BaseApplication> {
  readonly #container: Container
  readonly #services: FeatureLifecycle[] = []
  readonly #config = new ConfigDefinition()
  readonly #featureState = new Map<string, unknown>()
  readonly #installed = new Set<string>()

  constructor(options: ApplicationBuilderOptions = {}) {
    const c = options.container

    if (c != null && typeof (c as Container).get === 'function') {
      this.#container = c as Container
    } else {
      const opts = c != null ? (c as Partial<Options>) : {}
      this.#container = new CaffeineIoC({ ...opts, decorators: false })
      this.#container.autoWire()
    }

    // Configuration is unconditional: features read their own slices from the tree whether or not the
    // application ever declared one, so the module is installed here rather than by `.config()`. It reads the
    // definition at `container.init()`, by which point every feature has registered.
    //
    // The warning channel is wired here rather than inside `std/config`, which stays free of any host
    // dependency: a refresh that fails for one feature is contained rather than thrown, so it needs somewhere
    // to be heard.
    this.#config.warn = message => detectSignalDispatcher().warn(message)
    this.#container.bind(kConfigDefinition, t => t.toValue(this.#config))
    this.#container.addModules(ConfigModule(this.#config))
  }

  get container(): Container {
    return this.#container
  }

  /** The live configuration definition: its sources, root schema, resolution context and feature slices. */
  get configDefinition(): ConfigDefinition {
    return this.#config
  }

  addFeature(feature: FeatureLifecycle): this {
    this.#services.push(feature)
    return this
  }

  addModules(module: Module | ModuleFn, ...modules: Array<Module | ModuleFn>): this {
    this.#container.addModules(module, ...modules)
    return this
  }

  /**
   * Registers the application configuration: the schema it is validated against, and the key the resolved
   * handle is bound under. The callback returns an {@link AppConfigBuilder} whose type flows to features (e.g.
   * `.server(s => s.config(c => c.server))`); concrete builders expose this as `config()` and re-type themselves
   * to carry the resulting config type. Declare it first so features see the typed config.
   */
  protected applyConfigDefinition<T>(
    schema: ConfigSchema<unknown>,
    key: NamedToken<ConfigHandle<T>>,
    configure?: (c: AppConfigBuilder<T>) => void,
  ): void {
    this.#config.schema = schema
    this.#config.token = key
    configure?.(new AppConfigBuilder<T>(this.#config))
  }

  /**
   * Installs a feature, running `configure` against its builder in the same call. Callable at any point,
   * and once per {@link Feature.name} — an instanced feature (`kafka('orders')`) carries a distinct name, so
   * it does not clash with the default instance.
   *
   * The config type is recovered from this builder, so `v.config(c => c.app.view)` is typed against a schema
   * declared by `.config(...)` without naming it again. Declare the schema first so the selector sees it.
   *
   * ```ts
   * createWebApplication()
   *   .extend(view(), v => v.engine({ handlebars }))
   *   .extend(staticFiles(), s => s.serve(root))
   * ```
   *
   * @throws ErrFeatureAlreadyInstalled when a feature with the same {@link Feature.name} is already installed.
   */
  extend<F extends Feature>(
    this: this,
    feature: F,
    configure?: (b: ConfiguredBuilder<NoInfer<F>, ConfigTypeOf<this>>) => void,
  ): this
  // Implementation signature — hidden from callers, so the builder type the overload computes never has to
  // be re-derived here just to hand `configure` back to `install` unchanged.
  extend(feature: Feature, configure?: (b: any) => void): this {
    if (this.#installed.has(feature.name)) {
      throw new ErrFeatureAlreadyInstalled(feature.name)
    }
    this.#installed.add(feature.name)

    const ctx: PluginContext = {
      addFeature: feature => {
        this.addFeature(feature)
      },
      container: this.container,
      state: this.#featureState,
    }
    feature.install(ctx, configure)
    return this
  }

  /** The construction input shared by every application kind. Subclasses pass it to their app constructor. */
  protected applicationInit(): ApplicationInit {
    return {
      container: this.#container,
      services: this.#services,
      config: this.#config,
    }
  }

  abstract build(): App
}

/**
 * Re-parameterises the builder half of `Self`.
 *
 * A builder that changes one of its own type arguments — `config()` declaring the application config type —
 * cannot just name its own class as the return type when `Self` may already be a subclass or a previous
 * re-parameterisation. `Omit` strips the class's own keys, and intersecting with the next class puts the
 * full instance type back — private fields included.
 */
export type Reconfigured<Self, Base, Next> = Omit<Self, keyof Base> & Next

/**
 * Recovers the application config type from whatever builder a method was invoked on.
 *
 * `.extend`'s configure callback, and built-in methods such as `.server(s => s.config(...))`, read the
 * schema off this phantom rather than asking the caller to name it again. The builders carry
 * {@link ApplicationConfigMarker.__config} purely so this can read it back.
 *
 * The marker is optional, so a `Self` that carries none matches with `C` inferred as `unknown` — which is
 * exactly right: an application that never declared a schema has no shape to select from.
 */
export type ConfigTypeOf<Self> = Self extends { readonly __config?: infer C } ? C : unknown

/**
 * The builder `.extend` hands to `configure`, recovered from the feature `F` with its `.config(...)`
 * selector retyped against the application config type `C`.
 *
 * A {@link FeatureBuilder} is generic over its own slice type `T` only; `C` is the application's, known here
 * and nowhere the feature is authored. Recovering `T` structurally and swapping in the retyped `config` — via
 * `Omit`, so there is one signature and not an ambiguous overload pair — is all it takes: no phantom on the
 * builder, no higher-kinded encoding. A builder that is not a `FeatureBuilder` (view's per-engine builder,
 * `AuthorizationBuilder`) passes through unchanged.
 *
 * Call `.config(...)` **first** in a chain. `Omit` does not carry a class's polymorphic `this` through another
 * method's `this` return, so `k.brokers(x).config(c => c.app.y)` types `c` as `unknown` while
 * `k.config(c => c.app.y).brokers(x)` reads the application's schema.
 *
 * A helper that forwards a `configure` callback through to `.extend` names it with {@link FeatureConfigurer}
 * rather than casting.
 */
export type ConfiguredBuilder<F, C> =
  F extends Feature<infer B>
    ? B extends FeatureBuilder<infer T, any>
      ? RetypedConfig<B, C, T, F>
      : B extends { config(selector: (c: any) => ConfigLocation<infer T>): unknown }
        ? RetypedConfig<B, C, T, F>
        : B
    : never

type RetypedConfig<B, C, T, F> = Omit<B, 'config'> & {
  config(selector: (c: ConfigHandle<C>) => ConfigLocation<T>): ConfiguredBuilder<F, C>
}

/**
 * The callback `.extend(feature, …)` takes for a feature whose builder is `B`, over application config type
 * `C`.
 *
 * Name it wherever a helper forwards a `configure` through to `.extend` — a test harness, an application
 * factory — instead of casting at the call site. `{@link ConfiguredBuilder}` swaps the builder's `config`
 * signature, so a callback annotated with the bare builder type does not fit.
 *
 * ```ts
 * function corsApp(configure: FeatureConfigurer<CorsBuilder>) {
 *   return createWebApplication().extend(CORSExt(), configure)
 * }
 * ```
 */
export type FeatureConfigurer<B, C = unknown> = (builder: ConfiguredBuilder<Feature<B>, C>) => void

/**
 * The phantom an application builder carries to name its config type. Never assigned, never read at runtime —
 * `declare readonly __config?: T` on the class is the whole implementation.
 */
export interface ApplicationConfigMarker<T> {
  readonly __config?: T
}

/** A headless application builder. */
export class ApplicationBuilder<TConfig = unknown>
  extends BaseApplicationBuilder<Application>
  implements ApplicationConfigMarker<TConfig>
{
  /** Phantom — names the application config type for {@link ConfigTypeOf}. Never assigned, never read. */
  declare readonly __config?: TConfig

  // Registered unconditionally: the drain policy applies to every application, so `SHUTDOWN__DRAIN_DELAY` has
  // to work on one that never calls `.shutdown()`. Held so `.shutdown()` can configure it in place.
  readonly #shutdownBuilder: ShutdownBuilder<unknown>

  constructor(options: ApplicationBuilderOptions = {}) {
    super(options)
    this.#shutdownBuilder = new ShutdownBuilder<unknown>()
    this.addFeature(this.#shutdownBuilder)
  }

  build(): Application {
    return new Application(this.applicationInit())
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

  /**
   * Declares the application configuration — the schema it is validated against, and the key its resolved
   * {@link ConfigHandle} is bound under — and re-types the builder to carry the config type `T` inferred from
   * `schema`.
   *
   * The key is the application's, so the binding is typed: `container.get(key)` needs no type argument. The
   * schema comes first, which is what lets the compiler ask for the exact token type it implies.
   *
   * Re-typed so a feature's `.config(c => c.app.thing)` selector reads the config type off the builder it
   * was reached through, and a headless application configures kafka and messaging exactly the way an HTTP
   * one does.
   *
   * The key may name a **wider** type than the schema describes, which is what lets one key type serve an
   * application whose schema is assembled in pieces. It buys nothing where a field is concerned: the resolved
   * object holds exactly what the schema declared, so a key naming a field the schema does not describe reads
   * `undefined`.
   *
   * ```ts
   * const kConfig = token<ConfigHandle<AppConfig>>(Symbol('app.config'))
   *
   * createApplication().config(schema, kConfig, c => c.source(new EnvConfigProvider()))
   * ```
   *
   * Runtime returns the same instance; only the declared type changes.
   */
  config<S extends ConfigSchema, T extends InferConfig<NoInfer<S>> = InferConfig<NoInfer<S>>>(
    schema: S,
    key: NamedToken<ConfigHandle<T>>,
    configure?: (c: AppConfigBuilder<T>) => void,
  ): Reconfigured<this, ApplicationBuilder<TConfig>, ApplicationBuilder<T>> {
    this.applyConfigDefinition<T>(schema as ConfigSchema<unknown>, key, configure)
    return this as never
  }
}

/**
 * Creates a headless {@link Application} builder. Mirrors the HTTP `createWebApplication`.
 *
 * Install features with `.extend(feature, configure)` — unlike a factory argument it can be called at any
 * point in the chain.
 */
export function createApplication(options?: ApplicationBuilderOptions): ApplicationBuilder {
  return new ApplicationBuilder(options)
}

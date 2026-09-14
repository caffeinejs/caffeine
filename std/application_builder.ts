import { CaffeineIoC, type Container, type Module, type ModuleFn, type NamedToken, type Options } from '@caffeinejs/di'

import { AppConfigBuilder } from './app_config.js'
import { Application, type ApplicationInit } from './application.js'
import {
  ConfigDefinition,
  ConfigModule,
  kConfigDefinition,
  type ConfigHandle,
  type ConfigSchema,
  type InferConfig,
} from './config/index.js'
import { ErrFeatureAlreadyInstalled, kFeatureName, type Feature } from './feature.js'
import { kAddConfigurer, type FeatureConfigurer } from './feature_builder.js'
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
export abstract class BaseApplicationBuilder<App extends Application> {
  readonly #container: Container
  readonly #services: Feature[] = []
  readonly #config = new ConfigDefinition()
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

  /** The live configuration definition: its sources, root schema, profile path and feature slices. */
  get configDefinition(): ConfigDefinition {
    return this.#config
  }

  addFeature(feature: Feature): this {
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
   * `.server((s, c) => s.withConfig(c.server))`); concrete builders expose this as `config()` and re-type themselves
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
   * Installs a feature. Callable at any point, and once per {@link kFeatureName} — an instanced feature
   * (`kafka('orders')`) carries a distinct name, so it does not clash with the default instance.
   *
   * The feature's configure callback is written where the feature is constructed, and its second argument is
   * typed against the schema this builder declared with `.config(...)`. Declare the schema first so the
   * callback sees it.
   *
   * ```ts
   * createApplication()
   *   .config(schema, kConfig)
   *   .with(kafka((k, c) => k.brokers(c.app.kafka.brokers)))
   * ```
   *
   * @throws ErrFeatureAlreadyInstalled when a feature with the same {@link kFeatureName} is already installed.
   */
  with(feature: Feature<ConfigTypeOf<this>>): this {
    const name = feature[kFeatureName]

    if (this.#installed.has(name)) {
      throw new ErrFeatureAlreadyInstalled(name)
    }
    this.#installed.add(name)

    return this.addFeature(feature as Feature)
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
 * `.extend` reads the schema off this phantom rather than asking the caller to name it again. The builders
 * carry {@link ApplicationConfigMarker.__config} purely so this can read it back.
 *
 * The marker is optional, so a `Self` that carries none matches with `C` inferred as `unknown` — which is
 * exactly right: an application that never declared a schema has no shape to select from.
 */
export type ConfigTypeOf<Self> = Self extends { readonly __config?: infer C } ? C : unknown

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

  // Registered unconditionally: the drain policy applies to every application, probes or not. Configuration
  // reaches it only through `.shutdown((s, c) => s.withConfig(...))`. Held so `.shutdown()` can configure it
  // in place.
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
   * dispatcher that delivers them. The feature is registered either way, so this only overrides the defaults.
   * A fluent method is the last word; `SHUTDOWN__DRAIN_DELAY` reaches the feature only through
   * `.shutdown((s, c) => s.withConfig(c.shutdown))`.
   */
  shutdown(configure: FeatureConfigurer<ShutdownBuilder<TConfig>, TConfig>): this {
    this.#shutdownBuilder[kAddConfigurer](configure as never)
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
   * Re-typed so a feature's `.withConfig(c.app.thing)` reads the config type off the builder it was reached
   * through, and a headless application configures kafka and messaging exactly the way an HTTP one does.
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
 * Install features with `.with(feature)` or `.with(feature(configure))` — unlike a factory argument it
 * can be called at any point in the chain.
 */
export function createApplication(options?: ApplicationBuilderOptions): ApplicationBuilder {
  return new ApplicationBuilder(options)
}

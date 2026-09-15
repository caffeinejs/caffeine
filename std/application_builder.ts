import { CaffeineIoC, type Container, type Module, type ModuleFn, type Options } from '@caffeinejs/di'

import { Application, type ApplicationInit } from './application.js'
import { ConfigDefinition, ConfigModule, kConfigDefinition } from './config/index.js'
import type { AppConfiguration } from './configuration.js'
import { ErrFeatureAlreadyInstalled, kFeatureName, type Feature } from './feature.js'
import { kAddConfigurer, type FeatureConfigurer } from './feature_builder.js'
import { ShutdownBuilder } from './shutdown/shutdown_builder.js'
import { detectSignalDispatcher } from './shutdown/signals.js'

export interface ApplicationBuilderOptions<TConfig = unknown> {
  container?: Container | Options
  /** Built with {@link newConfiguration}. Omitted, the application resolves an empty, passthrough tree. */
  config?: AppConfiguration<TConfig>
}

/**
 * Platform-neutral builder foundation: owns container creation, the {@link Service} list, and the feature
 * install surface. Concrete builders (headless {@link ApplicationBuilder}, the HTTP `WebApplicationBuilder`)
 * extend it and implement {@link build}.
 *
 * The builder constructs the container with `decorators:false` and calls `autoWire()`; a caller-supplied,
 * already-wired container is used as-is.
 */
export abstract class BaseApplicationBuilder<App extends Application, TConfig = unknown> {
  readonly #container: Container
  readonly #services: Feature[] = []
  readonly #config: ConfigDefinition
  readonly #installed = new Set<string>()

  constructor(options: ApplicationBuilderOptions<TConfig> = {}) {
    const c = options.container

    if (c != null && typeof (c as Container).get === 'function') {
      this.#container = c as Container
    } else {
      const opts = c != null ? (c as Partial<Options>) : {}
      this.#container = new CaffeineIoC({ ...opts, decorators: false })
      this.#container.autoWire()
    }

    // Configuration is unconditional: features read their own slices from the tree whether or not the
    // application ever declared one, so the module is installed here regardless of `options.config`. It reads
    // the definition at `container.init()`, by which point every feature has registered.
    //
    // The warning channel is wired here rather than inside `std/config`, which stays free of any host
    // dependency: a refresh that fails for one feature is contained rather than thrown, so it needs somewhere
    // to be heard.
    this.#config = options.config ?? new ConfigDefinition()
    this.#config.warn = message => detectSignalDispatcher().warn(message)
    this.#container.bind(kConfigDefinition, t => t.toValue(this.#config))
    this.#container.addModules(ConfigModule(this.#config))
  }

  get container(): Container {
    return this.#container
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
   * Installs a feature. Callable at any point, and once per {@link kFeatureName} — an instanced feature
   * (`kafka('orders')`) carries a distinct name, so it does not clash with the default instance.
   *
   * The feature's configure callback is written where the feature is constructed, and its second argument is
   * typed against the schema the `config` constructor option declared.
   *
   * ```ts
   * const conf = newConfiguration(schema, kConfig).build()
   *
   * createApplication({ config: conf })
   *   .with(kafka((k, c) => k.brokers(c.app.kafka.brokers)))
   * ```
   *
   * @throws ErrFeatureAlreadyInstalled when a feature with the same {@link kFeatureName} is already installed.
   */
  with(feature: Feature<TConfig>): this {
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

/** A headless application builder. */
export class ApplicationBuilder<TConfig = unknown> extends BaseApplicationBuilder<Application, TConfig> {
  // Registered unconditionally: the drain policy applies to every application, probes or not. Configuration
  // reaches it only through `.shutdown((s, c) => s.withConfig(...))`. Held so `.shutdown()` can configure it
  // in place.
  readonly #shutdownBuilder: ShutdownBuilder<unknown>

  constructor(options: ApplicationBuilderOptions<TConfig> = {}) {
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
}

/**
 * Creates a headless {@link Application} builder. Mirrors the HTTP `createWebApplication`.
 *
 * Install features with `.with(feature)` or `.with(feature(configure))` — unlike a factory argument it
 * can be called at any point in the chain. Configuration is built separately with {@link newConfiguration}
 * and passed in as `{ config }`.
 */
export function createApplication<TConfig = unknown>(
  options?: ApplicationBuilderOptions<TConfig>,
): ApplicationBuilder<TConfig> {
  return new ApplicationBuilder(options)
}

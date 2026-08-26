import { CaffeineIoC, type Container, type Module, type Options } from '@caffeinejs/di'
import { Application, type ApplicationInit, type BaseApplication, type HookBinding } from './application.js'
import { AppConfigBuilder, kAppConfig } from './app_config.js'
import {
  ConfigDefinition,
  ConfigModule,
  kConfigDefinition,
  type ConfigSchema,
  type InferConfig,
} from './config/index.js'
import { ApplicationHooks } from './hooks.js'
import { type ApplicationEvent, hooksOf } from './decorators/lifecycle_registry.js'
import type { Augment, Plugin, PluginContext } from './plugin.js'
import type { Service } from './service.js'
import { type ShutdownConfig, resolveShutdownOptions } from './health/shutdown_options.js'
import { detectSignalDispatcher } from './health/signals.js'

export interface ApplicationBuilderOptions {
  container?: Container | Options
  /**
   * The graceful-shutdown policy: drain delay, teardown budget, which signals to install, and the dispatcher that
   * delivers them. Omitted, the defaults apply — signals installed outside a test runner, and a drain delay only
   * under an orchestrator. The HTTP application takes this from `.health(...)` instead.
   */
  shutdown?: ShutdownConfig
}

/**
 * Platform-neutral builder foundation: owns container creation, the {@link Service} list, the plugin
 * install surface, and the programmatic lifecycle hooks. Concrete builders (headless
 * {@link ApplicationBuilder}, the HTTP `WebApplicationBuilder`) extend it and implement {@link build}.
 *
 * Container wiring is **deferred**: the builder constructs the container with `decorators:false`, subscribes
 * to `onBindingRegistered` to collect the hook-bearing bindings (so discovery is O(k), no scan), then calls
 * `autoWire()`. A caller-supplied, already-wired container instead falls back to a one-time singleton scan.
 */
export abstract class BaseApplicationBuilder<App extends BaseApplication> {
  readonly #container: Container
  readonly #services: Service[] = []
  readonly #hooks = new ApplicationHooks<BaseApplication>()
  readonly #hookBindings: HookBinding[] | 'scan'
  readonly #shutdown: ShutdownConfig | undefined
  readonly #config = new ConfigDefinition(kAppConfig)

  constructor(options: ApplicationBuilderOptions = {}) {
    this.#shutdown = options.shutdown
    const c = options.container

    if (c != null && typeof (c as Container).get === 'function') {
      // Caller supplied a live container — it is already wired, so we cannot intercept registration.
      this.#container = c as Container
      this.#hookBindings = 'scan'
    } else {
      const opts = c != null ? (c as Partial<Options>) : {}
      this.#container = new CaffeineIoC({ ...opts, decorators: false })

      const collected: HookBinding[] = []
      // Live reference handed to the app; the listener stays attached so conditional bindings registered
      // during init() are collected too.
      this.#hookBindings = collected
      this.#container.hooks.on('onBindingRegistered', ({ key, binding }) => {
        const ctor = binding.type
        if (typeof ctor === 'function' && hooksOf(ctor) !== undefined) {
          collected.push({ key, ctor })
        }
      })
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
    this.#container.bind(kConfigDefinition).toValue(this.#config)
    this.#container.addModules(ConfigModule(this.#config))
  }

  get container(): Container {
    return this.#container
  }

  /** The live configuration definition: its sources, root schema, resolution context and feature slices. */
  get configDefinition(): ConfigDefinition {
    return this.#config
  }

  addService(service: Service): this {
    this.#services.push(service)
    return this
  }

  addModules(module: Module, ...modules: Module[]): this {
    this.#container.addModules(module, ...modules)
    return this
  }

  on(event: ApplicationEvent, listener: (app: App) => void | Promise<void>): this {
    this.#hooks.on(event, listener as (app: BaseApplication) => void | Promise<void>)
    return this
  }

  once(event: ApplicationEvent, listener: (app: App) => void | Promise<void>): this {
    this.#hooks.once(event, listener as (app: BaseApplication) => void | Promise<void>)
    return this
  }

  off(event: ApplicationEvent, listener: (app: App) => void | Promise<void>): this {
    this.#hooks.off(event, listener as (app: BaseApplication) => void | Promise<void>)
    return this
  }

  /**
   * Registers the application configuration. The callback returns an {@link AppConfigBuilder} whose type flows
   * to features (e.g. `.server(s => s.config(c => c.server))`); concrete builders expose this as `config()` and
   * re-type themselves to carry the resulting config type. Declare it first so features see the typed config.
   */
  protected applyConfigDefinition<T>(
    schema: ConfigSchema<T>,
    configure?: (c: AppConfigBuilder<T>) => void,
  ): void {
    this.#config.schema = schema as ConfigSchema<unknown>
    configure?.(new AppConfigBuilder<T>(this.#config))
  }

  /**
   * Dispatches the two shapes of `.config(...)`: with a schema, which also declares the application config
   * type, and without one, which only registers sources. The second exists because configuration is now
   * unconditional — an application may well want its sources in place, and its features configured from them,
   * without describing a root shape of its own.
   */
  protected applyConfigArgs<S extends ConfigSchema>(
    first: S | ((c: AppConfigBuilder<never>) => void),
    second?: (c: AppConfigBuilder<never>) => void,
  ): void {
    if (typeof first === 'function') {
      first(new AppConfigBuilder(this.#config) as AppConfigBuilder<never>)
      return
    }

    this.applyConfigDefinition<never>(first as ConfigSchema<never>, second)
  }

  /**
   * Installs plugins, merging each one's contributed methods onto this builder and re-typing it so they are
   * visible with autocomplete.
   *
   * Callable at any point, and more than once. Order does not matter: a builder that re-parameterises itself
   * (as the HTTP builder's `config()` does) carries the augments across, so `.extend(...).config(...)` and
   * `.config(...).extend(...)` are equally valid.
   *
   * ```ts
   * createWebApplication(fastifyAdapterFactory(server))
   *   .extend(viewPlugin(), staticPlugin())
   *   .view(v => v.engine({ handlebars }))
   * ```
   */
  extend<const S extends readonly Plugin[]>(...plugins: S): this & Augment<S> {
    installPlugins(this, plugins)
    return this as this & Augment<S>
  }

  /** The construction input shared by every application kind. Subclasses pass it to their app constructor. */
  protected applicationInit(): ApplicationInit {
    return {
      container: this.#container,
      services: this.#services,
      hookBindings: this.#hookBindings,
      hooks: this.#hooks,
      shutdown: resolveShutdownOptions(this.#shutdown),
      config: this.#config,
    }
  }

  abstract build(): App
}

/**
 * Re-parameterises the builder half of `Self` while keeping whatever a plugin merged onto it.
 *
 * A builder that changes one of its own type arguments — `config()` declaring the application config type —
 * cannot just name its own class as the return type: that discards the `& Augment<S>` an earlier `.extend()`
 * contributed, and the plugin's methods vanish from the chain. `Omit` strips the class's own keys, leaving
 * only the plugin-contributed ones, and intersecting with the re-parameterised class puts the full instance
 * type back — private fields included, so the result stays assignable wherever the builder is expected.
 */
export type Reconfigured<Self, Base, Next> = Omit<Self, keyof Base> & Next

/** Merges each plugin's contributed methods onto the builder and registers its configurer. */
export function installPlugins(
  builder: { readonly container: Container, addService(service: Service): void },
  plugins: readonly Plugin[],
): void {
  const ctx: PluginContext = {
    addService: service => { builder.addService(service) },
    container: builder.container,
  }

  for (const plugin of plugins) {
    Object.assign(builder, plugin.install(ctx))
  }
}

/** A headless application builder. */
export class ApplicationBuilder extends BaseApplicationBuilder<Application> {
  build(): Application {
    return new Application(this.applicationInit())
  }

  /**
   * Declares the application configuration, bound under `kAppConfig`. The `schema` argument determines the
   * config type; the optional `configure` callback (any shape) adds sources and context. A headless
   * application has no features that select config slices, so the builder is not re-typed; read the config via
   * `container.get<ConfigHandle<T>>(kAppConfig)` with the type at the use site.
   */
  config(configure: (c: AppConfigBuilder) => void): this
  config<S extends ConfigSchema>(
    schema: S,
    configure?: (c: AppConfigBuilder<InferConfig<S>>) => void,
  ): this
  config<S extends ConfigSchema>(
    first: S | ((c: AppConfigBuilder) => void),
    second?: (c: AppConfigBuilder<InferConfig<S>>) => void,
  ): this {
    this.applyConfigArgs(first, second)
    return this
  }
}

/**
 * Creates a headless {@link Application} builder. Mirrors the HTTP `createWebApplication`.
 *
 * Install plugins with `.extend(...)` — it is fully typed the same way, and unlike a factory argument it can
 * be called at any point in the chain.
 */
export function createApplication(options?: ApplicationBuilderOptions): ApplicationBuilder {
  return new ApplicationBuilder(options)
}

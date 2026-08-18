import { CaffeineIoC, type Container, type Module, type Options } from '@caffeinejs/di'
import { Application, type ApplicationInit, type BaseApplication, type HookBinding } from './application.js'
import { AppConfigBuilder } from './app_config.js'
import { ConfigModule, type ConfigSchema, type InferConfig } from './config/index.js'
import { ApplicationHooks } from './hooks.js'
import { type ApplicationEvent, hooksOf } from './decorators/lifecycle_registry.js'
import type { Augment, Plugin, PluginContext } from './plugin.js'
import type { Service } from './service.js'

export interface ApplicationBuilderOptions {
  container?: Container | Options
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

  constructor(options: ApplicationBuilderOptions = {}) {
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
  }

  get container(): Container {
    return this.#container
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
    const definition = new AppConfigBuilder<T>(schema)
    configure?.(definition)
    this.addModules(ConfigModule(definition.toOptions()))
  }

  /** The construction input shared by every application kind. Subclasses pass it to their app constructor. */
  protected applicationInit(): ApplicationInit {
    return {
      container: this.#container,
      services: this.#services,
      hookBindings: this.#hookBindings,
      hooks: this.#hooks,
    }
  }

  abstract build(): App
}

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
  config<S extends ConfigSchema>(
    schema: S,
    configure?: (c: AppConfigBuilder<InferConfig<S>>) => void,
  ): this {
    this.applyConfigDefinition<InferConfig<S>>(schema as ConfigSchema<InferConfig<S>>, configure)
    return this
  }
}

/**
 * Creates a headless {@link Application} builder, augmented with any plugins' methods (fully typed via
 * {@link Augment}). Mirrors the HTTP `createWebApplication`.
 */
export function createApplication<const S extends readonly Plugin[] = readonly []>(
  options?: ApplicationBuilderOptions,
  ...plugins: S
): ApplicationBuilder & Augment<S> {
  const builder = new ApplicationBuilder(options)
  installPlugins(builder, plugins)
  return builder as ApplicationBuilder & Augment<S>
}

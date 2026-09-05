import { CaffeineIoC, type Container, type Module, type ModuleFn, type NamedToken, type Options } from '@caffeinejs/di'

import { AppConfigBuilder } from './app_config.js'
import { Application, type ApplicationInit, type BaseApplication, type HookBinding } from './application.js'
import {
  ConfigDefinition,
  ConfigModule,
  kConfigDefinition,
  type ConfigHandle,
  type ConfigSchema,
  type InferConfig,
} from './config/index.js'
import { type ApplicationEvent, hooksOf } from './decorators/lifecycle_registry.js'
import { type ShutdownConfig, resolveShutdownOptions } from './health/shutdown_options.js'
import { detectSignalDispatcher } from './health/signals.js'
import { ApplicationHooks } from './hooks.js'
import type { BuilderOf, Feature, PluginContext } from './plugin.js'
import type { Service } from './service.js'

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
 * Platform-neutral builder foundation: owns container creation, the {@link Service} list, the feature
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
  readonly #config = new ConfigDefinition()
  readonly #featureState = new Map<string, unknown>()

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

  addService(service: Service): this {
    this.#services.push(service)
    return this
  }

  addModules(module: Module | ModuleFn, ...modules: Array<Module | ModuleFn>): this {
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
   * and more than once — once per singleton feature, once per keyed instance (`kafka('orders')`).
   *
   * The config type is recovered from this builder, so `k.config(c => c.app.events)` is typed against a
   * schema declared by `.config(...)` without naming it again. Declare the schema first so the selector sees it.
   *
   * ```ts
   * createWebApplication()
   *   .extend(ViewExt, v => v.engine({ handlebars }))
   *   .extend(StaticExt, s => s.serve(root))
   * ```
   */
  extend<F>(
    this: this,
    feature: F & Feature,
    configure?: (b: BuilderOf<NoInfer<F>, ConfigTypeOf<this>>) => void,
  ): this {
    const ctx: PluginContext = {
      addService: service => {
        this.addService(service)
      },
      container: this.container,
      on: (event, listener) => {
        this.on(event, listener as (app: App) => void | Promise<void>)
      },
      state: this.#featureState,
    }
    feature.install(ctx, configure as never)
    return this
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

  build(): Application {
    return new Application(this.applicationInit())
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
   * The key may name a **wider** type than the schema describes. A feature's namespace is in the resolved tree
   * whether or not the application declared it, so naming `server` in the key's type without redeclaring its
   * shape is accurate rather than a lie.
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

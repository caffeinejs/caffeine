import { CaffeineIoC, type Container, type Module, type ModuleFn, type Options } from '@caffeinejs/di'

import {
  activeProfiles,
  ConfigDefinition,
  ConfigModule,
  hostProfiles,
  kConfigDefinition,
  type ConfigHandle,
} from './config/index.js'
import type { AppConfiguration } from './configuration.js'
import { ErrCaffeine } from './error.js'
import {
  ErrFeatureAlreadyInstalled,
  kFeatureBootstrap,
  kFeatureConfigure,
  kFeatureName,
  type BootstrapKit,
  type Feature,
  type FeatureConfigureKit,
} from './feature.js'
import { kAddConfigurer, type FeatureConfigurer } from './feature_builder.js'
import { ApplicationAvailability } from './health/availability.js'
import { logToken, LoggerBuilder, type Logger } from './logger/index.js'
import { $t } from './schema/t.js'
import { GracefulShutdown } from './shutdown/shutdown.js'
import { ShutdownBuilder } from './shutdown/shutdown_builder.js'
import { type ShutdownOptions, defaultShutdownOptions, kShutdownPolicy } from './shutdown/shutdown_options.js'
import { detectSignalDispatcher } from './shutdown/signals.js'

export interface ApplicationOptions<TConfig = unknown> {
  container?: Container | Options
  /** Built with {@link newConfiguration}. Omitted, the application resolves an empty, passthrough tree. */
  config?: AppConfiguration<TConfig>
  /** A plain instance to use as-is, or `false` to disable the logger entirely. */
  logger?: Logger | false
}

/**
 * Post-run information {@link Application.run} resolves to. Application kinds widen it — the HTTP
 * application adds where the server bound — so a caller can `run().then(info => …)` without holding the
 * application reference.
 */
export interface RunInfo {
  /** The resolved application name from `caffeine.name`. */
  readonly name: string
  /** The active configuration profiles. */
  readonly profiles: readonly string[]
}

/** Where the framework's own block lives in the configuration tree. */
export const CAFFEINE_CONFIG_NAMESPACE = ['caffeine'] as const

/**
 * The framework's own configuration: read from `caffeine.*` by every application, whether or not the
 * application's schema declares it. Declaring it is what puts it in the application's own config object too.
 */
export interface CaffeineConfig {
  name: string
  profiles: string[]
}

export const DEFAULT_CAFFEINE_CONFIG: CaffeineConfig = { name: '', profiles: [] }

export const caffeineConfigSchema = $t.Object({
  name: $t.String({ default: DEFAULT_CAFFEINE_CONFIG.name }),
  profiles: $t.List($t.String(), { default: DEFAULT_CAFFEINE_CONFIG.profiles }),
})

/** Thrown when an application is configured after {@link Application.ready} has started. */
export class ErrApplicationStarted extends ErrCaffeine {
  constructor() {
    super('Cannot configure the application: it has already started', 'ERR_APPLICATION_STARTED')
  }
}

/**
 * A headless application: owns the DI container, the installed {@link Feature}s, and the lifecycle
 * (ready → run → close), with no serving platform. Bootstrap and destroy hooks live on the container: a class
 * binding that implements `OnBootstrap` / `OnDestroy` runs during `container.init()` / `container.dispose()`.
 * The HTTP `WebApplication` extends this and fills the protected `setup`/`start`/`stop` steps.
 *
 * Configures fluently, and is itself the running instance — there is no separate builder:
 *
 * ```ts
 * createApplication({ config: conf })
 *   .with(kafka((k, c) => k.brokers(c.app.kafka.brokers)))
 *   .shutdown(s => s.drainDelay('5s'))
 * ```
 */
export class Application<TConfig = unknown> {
  readonly #container: Container
  readonly #services: Feature[] = []
  readonly #installed = new Set<string>()
  readonly #availability = new ApplicationAvailability()
  readonly #config: ConfigDefinition

  // Registered unconditionally: the drain policy applies to every application, probes or not. Configuration
  // reaches it only through `.shutdown((s, c) => s.withConfig(...))`. Held so `.shutdown()` can configure it
  // in place.
  readonly #shutdownBuilder = new ShutdownBuilder<unknown>()

  // Registered unconditionally, like #shutdownBuilder: a `.logger(...)` call is deferred to this Feature's own
  // `configure()`, during `ready()`, so it sees resolved configuration. `#logger` (not just the builder) is
  // held too, seeded here in the constructor, so `log` answers before `ready()` without touching the
  // container — refreshed again once this builder's `configure()` has run.
  readonly #loggerBuilder = new LoggerBuilder<unknown>()
  #logger: Logger

  #handle: ConfigHandle<unknown> | undefined
  #name = ''
  #profiles: string[] = []
  #shutdownPolicy?: ShutdownOptions
  #booting = false
  #ready = false
  #shutdown?: GracefulShutdown
  #closing?: Promise<void>

  /**
   * Constructs the container with `decorators:false` and calls `autoWire()`; a caller-supplied, already-wired
   * container is used as-is.
   */
  constructor(options: ApplicationOptions<TConfig> = {}) {
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

    // Pushed directly, not through `addFeature`: a subclass's private fields do not exist yet while this
    // constructor runs, so an overridden method cannot be called from here.
    this.#services.push(this.#shutdownBuilder)
    this.#services.push(this.#loggerBuilder)

    // Seeds the builder from the simple, eager path; `.logger(configure)` layers on top of this during
    // `ready()`. Bound here so `logToken()` resolves even for an application that never calls `.logger()`.
    if (options.logger === false) {
      this.#loggerBuilder.disable(true)
    } else if (options.logger !== undefined) {
      this.#loggerBuilder.use(options.logger)
    }
    this.#logger = this.#loggerBuilder.logger
    this.#container.bind(logToken(), t => t.toValue(this.#logger))
  }

  get container(): Container {
    return this.#container
  }

  /** The application name from `caffeine.name`. Empty until {@link ready} has run. */
  get name(): string {
    return this.#name
  }

  get profiles(): readonly string[] {
    return [...this.#profiles]
  }

  /**
   * The application's availability: whether it has started, whether it is accepting work, and whether it is
   * draining. Owned here so every application kind has one, and read — never written — by the HTTP probes.
   */
  get availability(): ApplicationAvailability {
    return this.#availability
  }

  addFeature(feature: Feature): this {
    this.assertConfigurable()
    this.#services.push(feature)
    return this
  }

  addModules(module: Module | ModuleFn, ...modules: Array<Module | ModuleFn>): this {
    this.assertConfigurable()
    this.#container.addModules(module, ...modules)
    return this
  }

  /**
   * Installs a feature. Callable at any point before {@link ready}, and once per {@link kFeatureName} — an
   * instanced feature (`kafka('orders')`) carries a distinct name, so it does not clash with the default
   * instance.
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
   * @throws ErrApplicationStarted when {@link ready} has already started.
   */
  with(feature: Feature<TConfig>): this {
    this.assertConfigurable()

    const name = feature[kFeatureName]

    if (this.#installed.has(name)) {
      throw new ErrFeatureAlreadyInstalled(name)
    }
    this.#installed.add(name)

    return this.addFeature(feature as Feature)
  }

  /**
   * Configures graceful shutdown: the drain delay, the teardown budget, the signals that trigger it, and the
   * dispatcher that delivers them. The feature is registered either way, so this only overrides the defaults.
   * A fluent method is the last word; `SHUTDOWN__DRAIN_DELAY` reaches the feature only through
   * `.shutdown((s, c) => s.withConfig(c.shutdown))`.
   *
   * @throws ErrApplicationStarted when {@link ready} has already started.
   */
  shutdown(configure: FeatureConfigurer<ShutdownBuilder<TConfig>, TConfig>): this {
    this.assertConfigurable()
    this.#shutdownBuilder[kAddConfigurer](configure as never)
    return this
  }

  /** The application's logger. Always answers — a bare `ConsoleLogger` until something is configured. */
  get log(): Logger {
    return this.#logger
  }

  /**
   * Configures the application's logger, with access to the resolved configuration — `.logger((b, c) =>
   * b.disable(c.app.logEnabled))`. The feature is registered either way, so this only overrides the default.
   * Deferred to `ready()`, like every other feature: {@link log} and `logToken()` reflect it once `ready()`
   * has run, not as soon as this returns.
   *
   * @throws ErrApplicationStarted when {@link ready} has already started.
   */
  logger(configure: FeatureConfigurer<LoggerBuilder<TConfig>, TConfig>): this {
    this.assertConfigurable()
    this.#loggerBuilder[kAddConfigurer](configure as never)
    return this
  }

  /**
   * Refuses configuration once {@link ready} has started: the feature list is read once, so a later change
   * would be dropped rather than applied.
   */
  protected assertConfigurable(): void {
    if (this.#booting) {
      throw new ErrApplicationStarted()
    }
  }

  /**
   * Brings the application up to the point where it can serve.
   *
   * 1. the always-on `caffeine` slice is registered and the active profiles are decided;
   * 2. configuration **resolves**, once, already profile-aware;
   * 3. `caffeine.name` and the active profiles are applied;
   * 4. the application's {@link ApplicationAvailability} is bound;
   * 5. every feature **configures** — running the application's configure callback against its builder, then
   *    binding into the container;
   * 6. the container initializes;
   * 7. every feature **bootstraps** — looking up bindings;
   * 8. the platform is set up.
   *
   * Configuration resolves before any feature configures and while binding is still open, which is what lets a
   * feature be configured from a setting it then consumes at binding time. Resolving inside `container.init()`
   * would be too late for both.
   */
  async ready(): Promise<void> {
    if (this.#ready) {
      return
    }

    this.#booting = true

    // The framework's own block, registered directly: the application name and profiles are read before any
    // feature has configured, so its location is fixed rather than something a builder supplies.
    this.#config.frameworkDefaults.set(CAFFEINE_CONFIG_NAMESPACE, { ...DEFAULT_CAFFEINE_CONFIG })
    const caffeine = this.#config.slice<CaffeineConfig>(CAFFEINE_CONFIG_NAMESPACE, caffeineConfigSchema)

    // Decided before anything resolves, so the resolve that follows is profile-aware on its first and only
    // pass. The container's own set counts: `new CaffeineIoC({ profiles: ['test'] })` names a profile as
    // surely as an argument does, and the three union the way `addProfiles` always has.
    //
    // Empty, and only then, `FileConfigProvider` falls back to the `caffeine.profiles` its base file declares.
    const named = activeProfiles([...this.#container.profiles, ...hostProfiles()])
    this.#config.profiles = named

    // Captured once: a subclass assembles this list per call, and it must be the same list throughout.
    const features = this.configurers()

    const shard = await this.#config.bootstrap()
    this.#handle = shard.handle

    // What was named up front wins. Nothing was, so the base config file decided — and its value reached the
    // tree on the same resolve.
    const profiles = named.length > 0 ? named : activeProfiles(caffeine.config.profiles)
    if (profiles.length > 0) {
      this.#container.addProfiles(profiles[0], ...profiles.slice(1))
    }

    this.#name = caffeine.config.name
    this.#profiles = profiles

    // The application's own instance, bound before any feature configures so health (and anything else) can
    // inject it rather than closing over a kit field. The lifecycle writes to this object.
    this.#container.bind(ApplicationAvailability, t => t.toValue(this.#availability).internal())

    // Called in order and awaited together: every feature's configure callback — which the builder runs at the
    // top of its hook — has therefore run before the first feature does asynchronous work.
    const configurePending: Promise<void>[] = []

    for (const feature of features) {
      const result = feature[kFeatureConfigure](this.configureKit())
      if (result) {
        configurePending.push(result)
      }
    }

    if (configurePending.length > 0) {
      await Promise.all(configurePending)
    }

    // LoggerBuilder's own `configure()` already rebound `logToken()`; `#logger` is refreshed here too so
    // `.log` reflects a `.logger(configure)` call without going through the container, which isn't
    // initialized yet.
    this.#logger = this.#loggerBuilder.logger

    await this.#container.init()

    // Concurrent: a bootstrap hook only looks bindings up, so no feature's hook depends on another's.
    const kit = this.serviceKit()
    const bootstrapPending: Promise<void>[] = []

    for (const feature of features) {
      const result = feature[kFeatureBootstrap]?.(kit)
      if (result) {
        bootstrapPending.push(result)
      }
    }

    if (bootstrapPending.length > 0) {
      await Promise.all(bootstrapPending)
    }

    // The drain policy comes from whatever feature owns it, so it is read here rather than named by the
    // application: a shutdown starting before the platform finished setting up still uses the real budget.
    this.#shutdownPolicy = this.#container.getOptional(kShutdownPolicy)

    await this.setup()

    this.#ready = true
  }

  /** Readies the application if needed, starts it, and resolves to its {@link RunInfo}. */
  async run(): Promise<RunInfo> {
    if (!this.#ready) {
      await this.ready()
    }

    const options = this.shutdownOptions()

    this.#shutdown = new GracefulShutdown(() => this.close(), options.dispatcher)
    this.#shutdown.install(options.signals)

    await this.start()

    this.#availability.markStarted().acceptTraffic()

    return this.runInfo()
  }

  /**
   * Shuts down in the order an orchestrator needs, which is not the order a teardown alone would give.
   *
   * 1. availability starts refusing, so a readiness probe reports 503 on its very next poll — liveness stays
   *    correct, because a draining process must be left to finish, not restarted;
   * 2. the drain delay elapses while the application keeps working **normally**. The routing table has not caught
   *    up yet and real traffic is still arriving; rejecting it here is the bug this window exists to avoid;
   * 3. only then teardown runs — {@link stop}, then `container.dispose()` (which runs every `OnDestroy` hook).
   *
   * Step 2 has to precede teardown, which is why it is here and not an `OnDestroy` hook: the container disposes
   * its instances in parallel-safe reverse order with no place to hold a fixed delay ahead of them.
   */
  close(): Promise<void> {
    // An orchestrator re-sends SIGTERM, and a second close must join the first rather than start another one.
    this.#closing ??= this.#drainAndClose()
    return this.#closing
  }

  async #drainAndClose(): Promise<void> {
    const options = this.shutdownOptions()

    this.#availability.beginDrain()
    await this.beforeDrain()

    if (options.drainDelayMs > 0) {
      await delay(options.drainDelayMs)
    }

    const errors: unknown[] = []

    try {
      await this.stop()
    } catch (error) {
      errors.push(error)
    }

    try {
      await this.#container.dispose()
    } catch (error) {
      errors.push(error)
    }

    this.#availability.markBroken('closed')
    // Removed last, not first: until the shutdown actually finishes, a second signal must still reach the handler
    // that turns it into an immediate exit. Uninstalling up front hands that job back to the runtime's default
    // disposition, which kills the process mid-drain.
    this.#shutdown?.uninstall()

    if (errors.length > 0) {
      throw new AggregateError(errors, 'Errors during application shutdown')
    }
  }

  /**
   * The drain policy: what the shutdown feature published under {@link kShutdownPolicy}, else
   * {@link defaultShutdownOptions} — the latter only when a shutdown starts before the container has
   * initialized, since the feature is registered unconditionally and binds the key at configure.
   *
   * `.shutdown(s => s.drainDelay('10s'))` is how an application states its drain; the feature folds that with
   * the configuration tree and publishes the resolved policy here.
   */
  protected shutdownOptions(): ShutdownOptions {
    return this.#shutdownPolicy ?? defaultShutdownOptions()
  }

  /** Ran once availability has started refusing, before the drain delay. Subclasses invalidate caches here. */
  protected beforeDrain(): void | Promise<void> {
    // Nothing to invalidate in a bare application.
  }

  /** Assembles the {@link RunInfo} that {@link run} resolves to. Subclasses override to widen it. */
  protected runInfo(): RunInfo {
    return { name: this.name, profiles: this.profiles }
  }

  /**
   * The resolved application configuration. Readable from {@link setup} onward; before configuration has
   * resolved there is nothing to hand back.
   */
  protected get configHandle(): ConfigHandle<unknown> {
    if (this.#handle === undefined) {
      throw new Error('Configuration has not been resolved yet')
    }

    return this.#handle
  }

  /** Whether `ready()` has completed. */
  protected get started(): boolean {
    return this.#ready
  }

  /** The features installed on the application (before any framework-prepended ones). */
  protected get services(): readonly Feature[] {
    return this.#services
  }

  /**
   * The kit passed to {@link kFeatureConfigure}. Binding is still open.
   */
  protected configureKit(): FeatureConfigureKit {
    return {
      container: this.#container,
      // Non-null by construction: the only caller runs after `config.bootstrap()` resolved.
      config: this.#handle!,
    }
  }

  /**
   * The kit passed to {@link kFeatureBootstrap}. Binding is closed; the container exposes lookup only.
   */
  protected serviceKit(): BootstrapKit {
    return {
      container: this.#container,
      // Non-null by construction: the only caller runs after `config.bootstrap()` resolved.
      config: this.#handle!,
      // Refreshed once every feature configured, so this is the logger `.logger(...)` asked for.
      logger: this.#logger,
    }
  }

  /** The features configured then bootstrapped. Subclasses may prepend framework ones. */
  protected configurers(): Feature[] {
    return [...this.#services]
  }

  /** Ran during `ready()`, after `container.init()`. Subclasses wire their platform here. */
  protected setup(): Promise<void> {
    return Promise.resolve()
  }

  /** Ran during `run()`. Subclasses start serving here. */
  protected start(): Promise<void> {
    return Promise.resolve()
  }

  /** Ran during `close()`, before `container.dispose()`. Subclasses tear down their platform here. */
  protected stop(): Promise<void> {
    return Promise.resolve()
  }
}

/**
 * Creates a headless {@link Application}. Mirrors the HTTP `createWebApplication`.
 *
 * Install features with `.with(feature)` or `.with(feature(configure))` — can be called at any point in the
 * chain before `ready()`. Configuration is built separately with `newConfiguration` and passed in as
 * `{ config }`.
 */
export function createApplication<TConfig = unknown>(options?: ApplicationOptions<TConfig>): Application<TConfig> {
  return new Application(options)
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    // Unreferenced where the runtime supports it, so the wait cannot be the only thing keeping alive a process
    // that is trying to exit.
    setTimeout(resolve, ms).unref?.()
  })
}

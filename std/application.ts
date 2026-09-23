import { CaffeineIoC, type Container, type Module, type ModuleFn, type Options } from '@caffeinejs/di'

import {
  activeProfiles,
  ConfigModule,
  DEFAULT_LOAD_TIMEOUT_MS,
  hostProfiles,
  loadConfig,
  logConfigLoaded,
  type ConfigDefinition,
  type ConfigStore,
  type LiveConfig,
} from './config/index.js'
import { passthroughConfigSchema, validateConfig } from './config/schema.js'
import { kMergedTree } from './config/store.js'
import { readPath } from './config/tree.js'
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
import { ErrShutdownTimeout } from './shutdown/errors.js'
import { GracefulShutdown } from './shutdown/shutdown.js'
import { ShutdownBuilder } from './shutdown/shutdown_builder.js'
import { type ShutdownOptions, defaultShutdownOptions, kShutdownPolicy } from './shutdown/shutdown_options.js'

export interface ApplicationOptions<TConfig = unknown> {
  container?: Container | Options
  /** Built with {@link newConfiguration}. Omitted, the application loads no source and keeps every key. */
  config?: ConfigDefinition<TConfig>
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
 *   .with(kafka((k, { config }) => k.brokers(config.app.kafka.brokers)))
 *   .shutdown(s => s.drainDelay('5s'))
 * ```
 */
export class Application<TConfig = unknown> {
  readonly #container: Container
  readonly #services: Feature[] = []
  readonly #installed = new Set<string>()
  readonly #availability = new ApplicationAvailability()
  readonly #definition: ConfigDefinition<unknown>

  // Registered unconditionally: the drain policy applies to every application, probes or not. Configuration
  // reaches it only through `.shutdown((s, { config }) => s.config(...))`. Held so `.shutdown()` can configure
  // it in place.
  readonly #shutdownBuilder = new ShutdownBuilder<TConfig>()

  // Registered unconditionally, like #shutdownBuilder: a `.logger(...)` call is deferred to this Feature's own
  // `configure()`, during `ready()`, so it sees resolved configuration. `#logger` (not just the builder) is
  // held too, seeded here in the constructor, so `log` answers before `ready()` without touching the
  // container — refreshed again once this builder's `configure()` has run.
  readonly #loggerBuilder = new LoggerBuilder<TConfig>()
  #logger: Logger

  #store: ConfigStore<unknown> | undefined
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

    // Loaded in `ready()`, once the profiles are known. An application that declared nothing still loads: no
    // source, and a schema that keeps every key, so the framework's own block is read the same way.
    this.#definition = (options.config as ConfigDefinition<unknown> | undefined) ?? {
      schema: passthroughConfigSchema,
      key: undefined,
      storeKey: undefined,
      sources: [],
      loadTimeoutMs: DEFAULT_LOAD_TIMEOUT_MS,
    }

    // Pushed directly, not through `addFeature`: a subclass's private fields do not exist yet while this
    // constructor runs, so an overridden method cannot be called from here.
    this.#register(this.#shutdownBuilder)
    this.#register(this.#loggerBuilder)

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

  addFeature(feature: Feature<TConfig>): this {
    this.assertConfigurable()
    this.#register(feature)
    return this
  }

  /**
   * Records a feature without going through {@link addFeature}, which a subclass overrides — the constructor
   * runs before the subclass's own fields exist, so calling the override from there reads them unset.
   *
   * This is also the one place the application's configuration type is erased. `#services` is
   * `Feature<unknown>[]` because the store behind the kits is `ConfigStore<unknown>` by design, and a feature's
   * hooks take their kit as a method, so the parameter is bivariant and the erasure holds both ways.
   */
  #register(feature: Feature<TConfig>): void {
    this.#services.push(feature as Feature)
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
   *   .with(kafka((k, { config }) => k.brokers(config.app.kafka.brokers)))
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

    return this.addFeature(feature)
  }

  /**
   * Configures graceful shutdown: the drain delay, the teardown budget, the signals that trigger it, and the
   * dispatcher that delivers them. The feature is registered either way, so this only overrides the defaults.
   * A fluent method is the last word; `SHUTDOWN__DRAIN_DELAY` reaches the feature only through
   * `.shutdown((s, { config }) => s.config(config.shutdown))`.
   *
   * @throws ErrApplicationStarted when {@link ready} has already started.
   */
  shutdown(configure: FeatureConfigurer<ShutdownBuilder<TConfig>, TConfig>): this {
    this.assertConfigurable()
    this.#shutdownBuilder[kAddConfigurer](configure)
    return this
  }

  /** The application's logger. Always answers — a bare `ConsoleLogger` until something is configured. */
  get log(): Logger {
    return this.#logger
  }

  /**
   * Configures the application's logger, with access to the resolved configuration — `.logger((b, { config })
   * => b.disable(config.app.logEnabled))`. The feature is registered either way, so this only overrides the
   * default.
   * Deferred to `ready()`, like every other feature: {@link log} and `logToken()` reflect it once `ready()`
   * has run, not as soon as this returns.
   *
   * @throws ErrApplicationStarted when {@link ready} has already started.
   */
  logger(configure: FeatureConfigurer<LoggerBuilder<TConfig>, TConfig>): this {
    this.assertConfigurable()
    this.#loggerBuilder[kAddConfigurer](configure)
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
   * 1. the active profiles are decided;
   * 2. configuration **loads**, once, already profile-aware;
   * 3. `caffeine.name` and the active profiles are applied;
   * 4. the application's {@link ApplicationAvailability} is bound;
   * 5. every feature **configures** — running the application's configure callback against its builder, then
   *    binding into the container;
   * 6. the load is reported, through the logger the features settled on;
   * 7. the container initializes;
   * 8. every feature **bootstraps** — looking up bindings;
   * 9. the platform is set up, and the configuration's live sources start being watched.
   *
   * Configuration loads before any feature configures and while binding is still open, which is what lets a
   * feature be configured from a setting it then consumes at binding time. Loading inside `container.init()`
   * would be too late for both.
   */
  async ready(): Promise<void> {
    if (this.#ready) {
      return
    }

    this.#booting = true

    // Decided before anything loads, so the load that follows is profile-aware on its first and only pass. The
    // container's own set counts: `new CaffeineIoC({ profiles: ['test'] })` names a profile as surely as an
    // argument does, and the three union the way `addProfiles` always has.
    //
    // Empty, and only then, `FileConfigSource` falls back to the `caffeine.profiles` its base file declares.
    const named = activeProfiles([...this.#container.profiles, ...hostProfiles()])

    // Captured once: a subclass assembles this list per call, and it must be the same list throughout.
    const features = this.configurers()

    // Not started yet: every feature configures against one revision, and the triggers arm once this is done.
    const store = await loadConfig(this.#definition, { profiles: named, logger: () => this.#logger, start: false })
    this.#store = store
    this.#container.addModules(ConfigModule(store))

    // The store closes with the container, through a hook the module installs when the container initializes. A
    // failure before then would leave the sources it loaded open, with nothing left to close them.
    try {
      // The framework's own block, read from the merged tree: it is there whether or not the application's schema
      // declares it.
      const caffeine = validateConfig(
        caffeineConfigSchema,
        readPath(store[kMergedTree], CAFFEINE_CONFIG_NAMESPACE) ?? {},
      ) as CaffeineConfig

      // What was named up front wins. Nothing was, so the base config file decided, on the same load.
      const profiles = named.length > 0 ? named : activeProfiles(caffeine.profiles)
      if (profiles.length > 0) {
        this.#container.addProfiles(profiles[0], ...profiles.slice(1))
      }

      this.#name = caffeine.name
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

      // The logger is configured from configuration, so the load could not be reported until now.
      logConfigLoaded(this.#logger, store)

      await this.#container.init()
    } catch (error) {
      await store.close()
      throw error
    }

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

    store.start()
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

    const errors = await this.#teardown(options.shutdownTimeoutMs)

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

  /**
   * Stops the platform and disposes the container, inside one shared budget, and hands back whatever either
   * step threw.
   *
   * One budget rather than one each: what the boot-time check validated against the termination grace period is
   * `drainDelayMs + shutdownTimeoutMs`, so a full budget for disposal on top of one for the platform would put
   * `SIGKILL` inside the window that check promised. A budget of `0` waits indefinitely.
   *
   * On expiry {@link forceStop} cuts whatever the platform is still waiting on, and the teardown is then awaited
   * so the logs describing the overrun get out — the alternative at that point is `SIGKILL`, which truncates
   * them. The timeout leads the errors because it is the cause; anything the forced teardown then threw follows.
   */
  async #teardown(budgetMs: number): Promise<unknown[]> {
    const errors: unknown[] = []

    // Never rejects: both phases are caught, so the race below needs no rejection handler and disposal still
    // runs when `stop()` throws.
    const finished = (async (): Promise<void> => {
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
    })()

    if (budgetMs <= 0) {
      await finished
      return errors
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<'expired'>(resolve => {
      timer = setTimeout(() => resolve('expired'), budgetMs)
      timer.unref?.()
    })

    try {
      if ((await Promise.race([finished.then(() => 'done' as const), expired])) === 'done') {
        return errors
      }

      await this.forceStop()
      await finished

      errors.unshift(new ErrShutdownTimeout(budgetMs))
      return errors
    } finally {
      clearTimeout(timer)
    }
  }

  /** Ran once availability has started refusing, before the drain delay. Subclasses invalidate caches here. */
  protected beforeDrain(): void | Promise<void> {
    // Nothing to invalidate in a bare application.
  }

  /**
   * Abandons whatever {@link stop} is still waiting on, once the teardown budget is spent. Called only then, at
   * which point the orchestrator's `SIGKILL` is the alternative.
   */
  protected forceStop(): void | Promise<void> {
    // Nothing in flight in a bare application.
  }

  /** Assembles the {@link RunInfo} that {@link run} resolves to. Subclasses override to widen it. */
  protected runInfo(): RunInfo {
    return { name: this.name, profiles: this.profiles }
  }

  /** The live config object. Readable from {@link setup} onward. */
  protected get liveConfig(): LiveConfig<unknown> {
    return this.configStore.live
  }

  /**
   * The loaded configuration. Readable from {@link setup} onward; before configuration has loaded there is nothing
   * to hand back.
   */
  protected get configStore(): ConfigStore<unknown> {
    if (this.#store === undefined) {
      throw new Error('Configuration has not been loaded yet')
    }

    return this.#store
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
      config: this.configStore.live,
      store: this.configStore,
    }
  }

  /**
   * The kit passed to {@link kFeatureBootstrap}. Binding is closed; the container exposes lookup only.
   */
  protected serviceKit(): BootstrapKit {
    return {
      container: this.#container,
      config: this.configStore.live,
      store: this.configStore,
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

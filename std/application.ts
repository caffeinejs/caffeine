import { CaffeineIoC, Scopes, type Container, type Module, type ModuleFn, type Options } from '@caffeinejs/di'

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
import { ApplicationHealth } from './health/health.js'
import { loadHealthIndicators } from './health/load.js'
import { defaultHealthRegistryOptions, kHealthRegistryOptions } from './health/options.js'
import { HealthRegistry } from './health/registry.js'
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

/** Thrown when an application is readied or run once {@link Application.close} has been called. */
export class ErrApplicationClosed extends ErrCaffeine {
  constructor() {
    super(
      'Cannot start the application: it has been closed',
      'ERR_APPLICATION_CLOSED',
      undefined,
      'An application runs once: create a new one to start again',
    )
  }
}

/** Thrown when {@link Application.run} is called a second time. */
export class ErrApplicationRunning extends ErrCaffeine {
  constructor() {
    super('Cannot run the application: run() has already been called', 'ERR_APPLICATION_RUNNING')
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
  readonly #features: Feature[] = []
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
  #boot?: Promise<void>
  #ready = false
  #running = false
  #starting?: Promise<void>
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
   * draining. Owned here so every application kind has one, and read — never written — by
   * {@link ApplicationHealth}.
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
   * This is also the one place the application's configuration type is erased. `#features` is
   * `Feature<unknown>[]` because the store behind the kits is `ConfigStore<unknown>` by design, and a feature's
   * hooks take their kit as a method, so the parameter is bivariant and the erasure holds both ways.
   */
  #register(feature: Feature<TConfig>): void {
    this.#features.push(feature as Feature)
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
   *
   * Runs once: a later call — while booting or after — answers with the same promise, so a failed boot is not
   * retried.
   *
   * @throws ErrApplicationClosed once {@link close} has been called: a closed application is not started again.
   */
  ready(): Promise<void> {
    if (this.#closing !== undefined) {
      return Promise.reject(new ErrApplicationClosed())
    }

    this.#boot ??= this.#readyOnce()
    return this.#boot
  }

  async #readyOnce(): Promise<void> {
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

      // Every application has one probe service, whether or not anything exposes it: `health()` serves the HTTP
      // probes from it, and anything else injects the same instance, so every caller shares one evaluation. A
      // singleton even on a container whose default scope is not, for that reason; lazy, so an application that
      // never asks never snapshots its indicators. The budgets are what `health()` bound, if it was installed.
      this.#container.bind(ApplicationHealth, t =>
        t
          .toFactory(
            ctx =>
              new ApplicationHealth(
                ctx.container.get(ApplicationAvailability),
                new HealthRegistry(
                  loadHealthIndicators(ctx.container as Container),
                  ctx.container.getOptional(kHealthRegistryOptions) ?? defaultHealthRegistryOptions(),
                ),
              ),
          )
          .lifetime(Scopes.SINGLETON)
          .lazy()
          .internal(),
      )

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
    const kit = this.bootstrapKit()
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

  /**
   * Readies the application if needed, starts it, and resolves to its {@link RunInfo}.
   *
   * Runs once. A second call is refused, where one to {@link ready} or {@link close} joins the first: a subclass's
   * `run()` takes start options — the HTTP application's listen options — and joining would drop a second call's
   * without a word.
   *
   * @throws ErrApplicationRunning when `run()` has already been called, whatever became of that call.
   * @throws ErrApplicationClosed once {@link close} has been called, including while `run()` was still booting.
   */
  async run(): Promise<RunInfo> {
    // Ahead of the first await, so a second call is refused even while the first is still booting.
    if (this.#closing !== undefined) {
      throw new ErrApplicationClosed()
    }
    if (this.#running) {
      throw new ErrApplicationRunning()
    }
    this.#running = true

    if (!this.#ready) {
      await this.ready()
    }

    // A close that arrived during the boot wins: starting now would open what nothing is left to close.
    if (this.#closing !== undefined) {
      throw new ErrApplicationClosed()
    }

    const options = this.shutdownOptions()

    this.#shutdown = new GracefulShutdown(() => this.close(), options.dispatcher)
    this.#shutdown.install(options.signals)

    // Held so that a close arriving mid-start lets the start finish, and then stops what it opened.
    this.#starting = this.start()
    await this.#starting

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
   *
   * Safe at any point of the lifecycle, and final: a closed application is not readied or run again. Before
   * {@link ready} it tears nothing down, since nothing was brought up, and the application is closed all the same;
   * during it, it waits for the boot to settle first. An application that never served — readied but never run —
   * skips step 2, having no routing table to wait for. One still starting when the close arrives finishes starting,
   * so that what it opened is then closed. After a failed {@link ready}, it tears down what the boot brought
   * up and logs, rather than throws, what that teardown hits: `ready()` already reported the failure, and in a
   * `finally` a second error would replace it.
   *
   * @throws AggregateError when teardown fails or overruns its budget, `ErrShutdownTimeout` first — to the call
   * that started the shutdown only. Every other call waits for the same shutdown and resolves.
   */
  close(): Promise<void> {
    // An orchestrator re-sends SIGTERM, and a host may close what it already closed: a later call joins the
    // shutdown under way rather than starting another, and leaves reporting its outcome to the call that started it.
    if (this.#closing !== undefined) {
      return this.#closing.then(
        () => undefined,
        () => undefined,
      )
    }

    // Nothing was brought up, so nothing is torn down; it still ends where every other close does.
    if (this.#boot === undefined) {
      this.#availability.beginDrain()
      this.#availability.markBroken('closed')
      this.#closing = Promise.resolve()
      return this.#closing
    }

    // Synchronous when booted, so availability refuses before `close()` even returns.
    this.#closing = this.#ready ? this.#drainAndClose() : this.#closeAfterBoot(this.#boot)
    return this.#closing
  }

  /** A close that arrived before {@link ready} finished: waits for the boot, then closes what it left. */
  async #closeAfterBoot(boot: Promise<void>): Promise<void> {
    const booted = await boot.then(
      () => true,
      () => false,
    )

    if (booted) {
      return this.#drainAndClose()
    }

    this.#availability.beginDrain()

    for (const error of await this.#teardown(this.shutdownOptions().shutdownTimeoutMs)) {
      this.#logger.error({ err: error }, 'cannot tear down what a failed ready() brought up')
    }

    this.#availability.markBroken('closed')
    this.#shutdown?.uninstall()
  }

  async #drainAndClose(): Promise<void> {
    const options = this.shutdownOptions()
    // Read before the drain begins: only an application that served has a routing table to wait for.
    const served = this.#availability.started

    this.#availability.beginDrain()
    await this.beforeDrain()

    if (served && options.drainDelayMs > 0) {
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
      // A start that `run()` has under way finishes first. Stopped mid-start, a platform can open what the stop
      // already closed.
      await this.#starting?.catch(() => undefined)

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

  /** Ran once availability has started refusing, before the drain delay. */
  protected beforeDrain(): void | Promise<void> {
    // Nothing to do in a bare application.
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
  protected get features(): readonly Feature[] {
    return this.#features
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
  protected bootstrapKit(): BootstrapKit {
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
    return [...this.#features]
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

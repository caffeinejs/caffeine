import { type Container } from '@caffeinejs/di'

import { activeProfiles, ConfigDefinition, hostProfiles, type ConfigHandle } from './config/index.js'
import { kBootstrap, type BootstrapKit, type ExtensionRegistrar, type Feature } from './feature.js'
import { ApplicationAvailability } from './health/availability.js'
import { $t } from './schema/t.js'
import { GracefulShutdown } from './shutdown/shutdown.js'
import { type ShutdownOptions, defaultShutdownOptions, kShutdownPolicy } from './shutdown/shutdown_options.js'

/** Construction input for an {@link Application}, produced by a {@link BaseApplicationBuilder}. */
export interface ApplicationInit {
  container: Container
  services: Feature[]
  /** The live configuration definition, handed to every service so it can contribute to the tree. */
  config?: ConfigDefinition
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

/** An application with no platform runs no extensions, so what a feature contributes is dropped. */
const NOOP_REGISTRAR: ExtensionRegistrar = {
  register() {
    return undefined
  },
}

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

/**
 * A headless application: owns the DI container, the configuration {@link Service}s, and the lifecycle
 * (ready → run → close), with no serving platform. Bootstrap and destroy hooks live on the container: a class
 * binding that implements `OnBootstrap` / `OnDestroy` runs during `container.init()` / `container.dispose()`.
 * The HTTP `WebApplication` extends this and fills the protected `setup`/`start`/`stop` steps.
 */
export class Application {
  readonly #container: Container
  readonly #services: Feature[]
  readonly #availability = new ApplicationAvailability()
  readonly #config: ConfigDefinition

  #handle: ConfigHandle<unknown> | undefined
  #name = ''
  #profiles: string[] = []
  #shutdownPolicy?: ShutdownOptions
  #ready = false
  #shutdown?: GracefulShutdown
  #closing?: Promise<void>

  constructor(init: ApplicationInit) {
    this.#container = init.container
    this.#services = init.services
    // An application constructed without a builder still gets one, so services can register unconditionally.
    // Nothing bootstraps it in that case, which is what a missing config module means.
    this.#config = init.config ?? new ConfigDefinition()
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

  /**
   * Where the feature at `order` contributes start-up wiring. A headless application runs none, so what a
   * feature registers here goes nowhere; a platform overrides this with a registrar of its own.
   */
  protected extensionRegistrar(_order: number): ExtensionRegistrar {
    return NOOP_REGISTRAR
  }

  /**
   * Brings the application up to the point where it can serve.
   *
   * 1. the always-on `caffeine` slice is registered and the active profiles are decided;
   * 2. configuration **resolves**, once, already profile-aware;
   * 3. `caffeine.name` and the active profiles are applied;
   * 4. every feature **bootstraps** — running the application's configure callback against its builder, then
   *    binding into the container and registering its extensions;
   * 5. the container initializes and the platform is set up.
   *
   * Configuration resolves before any feature bootstraps and while binding is still open, which is what lets a
   * feature be configured from a setting it then consumes at binding time. Resolving inside `container.init()`
   * would be too late for both.
   */
  async ready(): Promise<void> {
    if (this.#ready) {
      return
    }

    // The framework's own block, registered directly: the application name and profiles are read before any
    // feature has bootstrapped, so its location is fixed rather than something a builder supplies.
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

    // Each feature gets its own kit, carrying its position in the feature list. Extensions are registered
    // against that position rather than against the moment the hook reached the call, so what a feature awaits
    // before registering cannot move it past a feature installed after it.
    //
    // Called in order and awaited together: every feature's configure callback — which the builder runs at the
    // top of its hook — has therefore run before the first feature does asynchronous work.
    const bootstrapPending: Promise<void>[] = []

    features.forEach((feature, index) => {
      const result = feature[kBootstrap](this.serviceKit(index))
      if (result) {
        bootstrapPending.push(result)
      }
    })

    if (bootstrapPending.length > 0) {
      await Promise.all(bootstrapPending)
    }

    await this.#container.init()

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
   * initialized, since the feature is registered unconditionally and binds the key at bootstrap.
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

  /** The features registered on the builder (before any framework-prepended ones). */
  protected get services(): readonly Feature[] {
    return this.#services
  }

  /**
   * The kit passed to the {@link Feature} at `order`. Subclasses may widen it (e.g. add platform
   * handles).
   *
   * @param order - The feature's position in {@link configurers}, which is the order what it registers with
   *   {@link BootstrapKit.extensions} runs in.
   */
  protected serviceKit(order: number): BootstrapKit {
    return {
      container: this.#container,
      availability: this.#availability,
      // Non-null by construction: the only caller runs after `config.bootstrap()` resolved.
      config: this.#handle!,
      extensions: this.extensionRegistrar(order),
    }
  }

  /** The features bootstrapped before `container.init()`. Subclasses may prepend framework ones. */
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

function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    // Unreferenced where the runtime supports it, so the wait cannot be the only thing keeping alive a process
    // that is trying to exit.
    setTimeout(resolve, ms).unref?.()
  })
}

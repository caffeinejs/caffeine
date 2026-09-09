import { type Container } from '@caffeinejs/di'

import { activeProfiles, ConfigDefinition } from './config/index.js'
import { Extensions } from './extensions.js'
import { kBeforeBootstrap, kBootstrap, type BootstrapKit, type FeatureLifecycle } from './feature.js'
import { ApplicationAvailability } from './health/availability.js'
import { $t } from './schema/t.js'
import { GracefulShutdown } from './shutdown/shutdown.js'
import { type ShutdownOptions, defaultShutdownOptions, kShutdownPolicy } from './shutdown/shutdown_options.js'

/** Construction input for a {@link BaseApplication}, produced by an {@link BaseApplicationBuilder}. */
export interface ApplicationInit {
  container: Container
  services: FeatureLifecycle[]
  /** The live configuration definition, handed to every service so it can contribute to the tree. */
  config?: ConfigDefinition
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

/**
 * Platform-neutral application foundation: owns the DI container, the configuration {@link Service}s, and
 * the lifecycle (ready → run → close). Bootstrap and destroy hooks live on the container: a class binding
 * that implements `OnBootstrap` / `OnDestroy` runs during `container.init()` / `container.dispose()`.
 * Concrete apps (headless {@link Application}, the HTTP `WebApplication`) extend it and fill the protected
 * `setup`/`start`/`stop` steps.
 */
export abstract class BaseApplication {
  readonly #container: Container
  readonly #services: FeatureLifecycle[]
  readonly #availability = new ApplicationAvailability()
  readonly #extensions: Extensions
  readonly #config: ConfigDefinition

  #name = ''
  #profiles: string[] = []
  #shutdownPolicy?: ShutdownOptions
  #ready = false
  #shutdown?: GracefulShutdown
  #closing?: Promise<void>

  constructor(init: ApplicationInit) {
    this.#container = init.container
    this.#extensions = new Extensions(this.#container)
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
   * The extensions the features registered. Resolving through it needs an initialized container, so it is for
   * the {@link setup} step and later.
   */
  protected get extensions(): Extensions {
    return this.#extensions
  }

  /**
   * Brings the application up to the point where it can serve.
   *
   * 1. the always-on `caffeine` slice is registered, then every service **declares**;
   * 2. configuration **resolves** — a pre-pass reads `caffeine.profiles` so the real resolve is profile-aware
   *    — and every slice publishes;
   * 3. `caffeine.name` and `caffeine.profiles` are applied;
   * 4. every service **configures** — binding into the container and registering its extensions, now able to
   *    read its own settings;
   * 5. the container initializes and the platform is set up.
   *
   * Declare and resolve are separate so a feature can read its resolved configuration while it is still able
   * to bind. Resolving inside `container.init()` — after every service had configured — is what used to make
   * a setting consumed at binding time impossible to configure at all.
   */
  async ready(): Promise<void> {
    if (this.#ready) {
      return
    }

    // Registered directly rather than through `defineFeatureConfig`, which places a *feature* — and a feature
    // only lives where the application pointed it. This block is the framework's own: the application name and
    // profiles are read before any service has configured, so its location cannot be something a builder
    // supplies.
    this.#config.frameworkDefaults.set(CAFFEINE_CONFIG_NAMESPACE, { ...DEFAULT_CAFFEINE_CONFIG })
    const caffeine = this.#config.slice<CaffeineConfig>(CAFFEINE_CONFIG_NAMESPACE, caffeineConfigSchema)

    // Discovered in a pre-pass so a file or remote source resolves profile-aware: `caffeine.profiles` set from
    // any source — an environment variable, an argument, a file — drives which `application-<profile>` overlays
    // load on the resolve that follows.
    this.#config.profilesPath = [...CAFFEINE_CONFIG_NAMESPACE, 'profiles']

    // Captured once: a subclass assembles this list per call, and both steps must reach the same services.
    const services = this.configurers()

    const beforeBootstrapKit = { config: this.#config, container: this.#container }
    const beforeBootstrapPending: Promise<void>[] = []
    for (const service of services) {
      const result = service[kBeforeBootstrap]?.(beforeBootstrapKit)
      if (result) {
        beforeBootstrapPending.push(result)
      }
    }
    if (beforeBootstrapPending.length > 0) {
      await Promise.all(beforeBootstrapPending)
    }
    await this.#config.bootstrap()

    const profiles = activeProfiles(caffeine.config.profiles)
    if (profiles.length > 0) {
      this.#container.addProfiles(profiles[0], ...profiles.slice(1))
    }

    this.#name = caffeine.config.name
    this.#profiles = profiles

    // Each feature gets its own kit, carrying its position in the feature list. Extensions are registered
    // against that position rather than against the moment the hook reached the call, so what a feature awaits
    // before registering cannot move it past a feature installed after it.
    const bootstrapPending: Promise<void>[] = []
    services.forEach((service, index) => {
      const result = service[kBootstrap](this.serviceKit(index))
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

  /** Readies the application if needed, then starts it. */
  async run(): Promise<void> {
    if (!this.#ready) {
      await this.ready()
    }

    const options = this.shutdownOptions()

    this.#shutdown = new GracefulShutdown(() => this.close(), options.dispatcher)
    this.#shutdown.install(options.signals)

    await this.start()

    this.#availability.markStarted().acceptTraffic()
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

  /** Whether `ready()` has completed. */
  protected get started(): boolean {
    return this.#ready
  }

  /** The features registered on the builder (before any framework-prepended ones). */
  protected get services(): readonly FeatureLifecycle[] {
    return this.#services
  }

  /**
   * The kit passed to the {@link FeatureLifecycle} at `order`. Subclasses may widen it (e.g. add platform
   * handles).
   *
   * @param order - The feature's position in {@link configurers}, which is what the extensions it registers
   *   are sorted by.
   */
  protected serviceKit(order: number): BootstrapKit {
    return {
      container: this.#container,
      availability: this.#availability,
      config: this.#config,
      extensions: this.#extensions.at(order),
    }
  }

  /** The features bootstrapped before `container.init()`. Subclasses may prepend framework ones. */
  protected configurers(): FeatureLifecycle[] {
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

/** A headless application: DI container + lifecycle, no serving platform. */
export class Application extends BaseApplication {}

import { type Binding, type Container, type InjectionToken, Scopes } from '@caffeinejs/di'

import { ConfigDefinition } from './config/index.js'
import { type ApplicationEvent, hooksOf } from './decorators/lifecycle_registry.js'
import { Extensions } from './extensions.js'
import { kBeforeBootstrap, kBootstrap, type BootstrapKit, type FeatureLifecycle } from './feature.js'
import { ApplicationAvailability } from './health/availability.js'
import { ApplicationHooks } from './hooks.js'
import { $t } from './schema/t.js'
import { GracefulShutdown } from './shutdown/shutdown.js'
import { type ShutdownOptions, defaultShutdownOptions, kShutdownPolicy } from './shutdown/shutdown_options.js'

/** A hook-bearing binding collected at registration time (fast-path discovery). */
export interface HookBinding {
  key: InjectionToken
  ctor: Function
}

/** Construction input for a {@link BaseApplication}, produced by an {@link BaseApplicationBuilder}. */
export interface ApplicationInit {
  container: Container
  services: FeatureLifecycle[]
  // The hook-bearing bindings collected via `onBindingRegistered`, or `'scan'` to discover them by a
  // one-time singleton scan (used when the container was supplied pre-wired).
  hookBindings: HookBinding[] | 'scan'
  hooks: ApplicationHooks<BaseApplication>
  /** The live configuration definition, handed to every service so it can contribute to the tree. */
  config?: ConfigDefinition
}

interface Dispatch {
  instance: object
  method: string | symbol
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
 * the lifecycle (ready → run → shutdown) with both decorator-driven (`@OnApplicationReady`, ...) and
 * programmatic (`on`/`once`/`off`) hooks. Concrete apps (headless {@link Application}, the HTTP
 * `WebApplication`) extend it and fill the protected `onReady`/`onRun`/`onShutdown` steps.
 */
export abstract class BaseApplication {
  readonly #container: Container
  readonly #services: FeatureLifecycle[]
  readonly #hooks: ApplicationHooks<BaseApplication>
  readonly #hookBindings: HookBinding[] | 'scan'
  readonly #availability = new ApplicationAvailability()
  readonly #extensions: Extensions
  readonly #config: ConfigDefinition

  #name = ''
  #profiles: string[] = []
  #dispatch?: Map<ApplicationEvent, Dispatch[]>
  #shutdownPolicy?: ShutdownOptions
  #ready = false
  #shutdown?: GracefulShutdown
  #closing?: Promise<void>

  constructor(init: ApplicationInit) {
    this.#container = init.container
    this.#extensions = new Extensions(this.#container)
    this.#services = init.services
    this.#hookBindings = init.hookBindings
    this.#hooks = init.hooks
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

  /** Registers a lifecycle listener. Throws if the same listener is already registered for the event. */
  on(event: ApplicationEvent, listener: (app: this) => void | Promise<void>): this {
    this.#hooks.on(event, listener as (app: BaseApplication) => void | Promise<void>)
    return this
  }

  /** Registers a lifecycle listener removed after it runs once. */
  once(event: ApplicationEvent, listener: (app: this) => void | Promise<void>): this {
    this.#hooks.once(event, listener as (app: BaseApplication) => void | Promise<void>)
    return this
  }

  /** Removes a previously registered lifecycle listener. */
  off(event: ApplicationEvent, listener: (app: this) => void | Promise<void>): this {
    this.#hooks.off(event, listener as (app: BaseApplication) => void | Promise<void>)
    return this
  }

  /** @deprecated Register with `on('application:ready', ...)`. */
  onReady(hook: () => void | Promise<void>): this {
    return this.on('application:ready', () => hook())
  }

  /** @deprecated Register with `on('application:pre-shutdown', ...)`. */
  onClose(hook: () => void | Promise<void>): this {
    return this.on('application:pre-shutdown', () => hook())
  }

  /**
   * Brings the application up to the point where it can serve.
   *
   * 1. the always-on `caffeine` slice is registered, then every service **declares**;
   * 2. configuration **resolves**, and every slice publishes;
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

    // Captured once: a subclass assembles this list per call, and both steps must reach the same services.
    const services = this.configurers()

    await Promise.all(
      services.map(service =>
        Promise.resolve(service[kBeforeBootstrap]?.({ config: this.#config, container: this.#container })),
      ),
    )
    await this.#config.bootstrap()

    const profiles = caffeine.config.profiles.filter(profile => profile !== '')
    if (profiles.length > 0) {
      this.#container.addProfiles(profiles[0], ...profiles.slice(1))
    }

    this.#name = caffeine.config.name
    this.#profiles = caffeine.config.profiles

    // Each feature gets its own kit, carrying its position in the feature list. Extensions are registered
    // against that position rather than against the moment the hook reached the call, so what a feature awaits
    // before registering cannot move it past a feature installed after it.
    await Promise.all(services.map((service, index) => service[kBootstrap](this.serviceKit(index))))

    await this.#container.init()

    // The drain policy comes from whatever feature owns it, so it is read here rather than named by the
    // application: a shutdown starting before the platform finished setting up still uses the real budget.
    this.#shutdownPolicy = this.#container.getOptional(kShutdownPolicy)

    await this.setup()

    this.#dispatch = this.buildDispatch()

    await this.emit('application:ready')

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

    await this.emit('application:run')
    await this.start()

    this.#availability.markStarted().acceptTraffic()
  }

  /**
   * Shuts down in the order an orchestrator needs, which is not the order the lifecycle hooks alone would give.
   *
   * 1. availability starts refusing, so a readiness probe reports 503 on its very next poll — liveness stays
   *    correct, because a draining process must be left to finish, not restarted;
   * 2. the drain delay elapses while the application keeps working **normally**. The routing table has not caught
   *    up yet and real traffic is still arriving; rejecting it here is the bug this window exists to avoid;
   * 3. only then the hooks run — pre-shutdown, {@link stop}, shutdown, container dispose.
   *
   * Step 2 has to precede every user hook, which is why it cannot be one: `application:pre-shutdown` listeners are
   * dispatched in parallel and best-effort, so a drain hung off that event would race arbitrary user code.
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

    await this.emitBestEffort('application:pre-shutdown', errors)
    try {
      await this.stop()
    } catch (error) {
      errors.push(error)
    }

    await this.emitBestEffort('application:shutdown', errors)
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

  /** Ran during `close()`, between the shutdown hooks. Subclasses tear down their platform here. */
  protected stop(): Promise<void> {
    return Promise.resolve()
  }

  // Resolves the singleton beans carrying lifecycle hooks and indexes their methods by event.
  private buildDispatch(): Map<ApplicationEvent, Dispatch[]> {
    const dispatch = new Map<ApplicationEvent, Dispatch[]>()

    // One walk of the registry, indexed by key. The compiled registry binding (it carries the factory after
    // init) has to come from the registry rather than `getBinding(key)`, so that label-indexed beans such as
    // controllers — which `get(key)` / `wrap(key)` cannot resolve directly — are still found. Looking each one
    // up with `getBindingsBy` instead made this quadratic in the number of bindings.
    const registry = new Map<InjectionToken, Binding>(this.#container.entries())

    const candidates: HookBinding[] =
      this.#hookBindings === 'scan'
        ? [...registry]
            .filter(([, b]) => typeof b.type === 'function' && hooksOf(b.type) !== undefined)
            .map(([key, b]) => ({ key, ctor: b.type as Function }))
        : this.#hookBindings

    for (const { key, ctor } of candidates) {
      const hooks = hooksOf(ctor)
      if (hooks === undefined) {
        continue
      }

      const binding = registry.get(key)
      if (binding === undefined) {
        continue
      }

      // An unset scopeID means the container default (singleton unless configured otherwise); only an
      // explicit non-singleton scope (transient/request) opts a bean out of application lifecycle hooks.
      if (binding.scopeID !== undefined && binding.scopeID !== Scopes.SINGLETON) {
        continue
      }

      const instance = this.#container.wrapBinding<object>(binding).get()
      for (const [event, methods] of hooks) {
        let list = dispatch.get(event)
        if (list === undefined) {
          list = []
          dispatch.set(event, list)
        }
        for (const method of methods) {
          list.push({ instance, method })
        }
      }
    }

    return dispatch
  }

  // Fail-fast: run bean hooks then programmatic listeners sequentially; the first rejection propagates.
  private async emit(event: ApplicationEvent): Promise<void> {
    for (const { instance, method } of this.#dispatch?.get(event) ?? []) {
      await (instance as Record<string | symbol, () => unknown>)[method]()
    }
    for (const listener of this.#hooks.listenersFor(event)) {
      await listener(this)
    }
  }

  // Best-effort: run every hook even if some reject; collect failures into `errors` instead of aborting.
  // Wrap each call so a synchronous throw becomes a rejection (otherwise it would escape allSettled).
  private async emitBestEffort(event: ApplicationEvent, errors: unknown[]): Promise<void> {
    const invoke = (call: () => unknown): Promise<unknown> => {
      try {
        return Promise.resolve(call())
      } catch (error) {
        return Promise.reject(error)
      }
    }

    const calls: Array<Promise<unknown>> = [
      ...(this.#dispatch?.get(event) ?? []).map(({ instance, method }) =>
        invoke(() => (instance as Record<string | symbol, () => unknown>)[method]()),
      ),
      ...this.#hooks.listenersFor(event).map(listener => invoke(() => listener(this))),
    ]

    for (const result of await Promise.allSettled(calls)) {
      if (result.status === 'rejected') {
        errors.push(result.reason)
      }
    }
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

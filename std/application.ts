import { type Container, type Key, Scopes } from '@caffeinejs/di'
import { ApplicationHooks } from './hooks.js'
import { type ApplicationEvent, hooksOf } from './decorators/lifecycle_registry.js'
import { kServiceConfigure, type Service, type ServiceKit } from './service.js'

/** A hook-bearing binding collected at registration time (fast-path discovery). */
export interface HookBinding {
  key: Key
  ctor: Function
}

/** Construction input for a {@link BaseApplication}, produced by an {@link BaseApplicationBuilder}. */
export interface ApplicationInit {
  container: Container
  services: Service[]
  // The hook-bearing bindings collected via `onBindingRegistered`, or `'scan'` to discover them by a
  // one-time singleton scan (used when the container was supplied pre-wired).
  hookBindings: HookBinding[] | 'scan'
  hooks: ApplicationHooks<BaseApplication>
}

interface Dispatch {
  instance: object
  method: string | symbol
}

/**
 * Platform-neutral application foundation: owns the DI container, the configuration {@link Service}s, and
 * the lifecycle (ready → run → shutdown) with both decorator-driven (`@OnApplicationReady`, ...) and
 * programmatic (`on`/`once`/`off`) hooks. Concrete apps (headless {@link Application}, the HTTP
 * `WebApplication`) extend it and fill the protected `onReady`/`onRun`/`onShutdown` steps.
 */
export abstract class BaseApplication {
  readonly #container: Container
  readonly #services: Service[]
  readonly #hooks: ApplicationHooks<BaseApplication>
  readonly #hookBindings: HookBinding[] | 'scan'
  #dispatch?: Map<ApplicationEvent, Dispatch[]>
  #ready = false

  constructor(init: ApplicationInit) {
    this.#container = init.container
    this.#services = init.services
    this.#hookBindings = init.hookBindings
    this.#hooks = init.hooks
  }

  get container(): Container {
    return this.#container
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

  async ready(): Promise<void> {
    if (this.#ready) {
      return
    }

    const kit = this.serviceKit()

    await Promise.all(this.configurers().map(service => service[kServiceConfigure](kit)))
    await this.#container.init()
    await this.setup()

    this.#dispatch = this.buildDispatch()

    await this.emit('application:ready')

    this.#ready = true
  }

  async run(): Promise<void> {
    if (!this.#ready) {
      await this.ready()
    }

    await this.emit('application:run')
    await this.start()
  }

  async close(): Promise<void> {
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

    if (errors.length > 0) {
      throw new AggregateError(errors, 'Errors during application shutdown')
    }
  }

  /** Whether `ready()` has completed. */
  protected get started(): boolean {
    return this.#ready
  }

  /** The services registered on the builder (before any framework-prepended configurers). */
  protected get services(): readonly Service[] {
    return this.#services
  }

  /** The kit passed to each {@link Service}. Subclasses may widen it (e.g. add platform handles). */
  protected serviceKit(): ServiceKit {
    return { container: this.#container }
  }

  /** The services configured before `container.init()`. Subclasses may prepend framework configurers. */
  protected configurers(): Service[] {
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

    const candidates: HookBinding[] = this.#hookBindings === 'scan'
      ? this.#container
          .getBindingsBy(d => typeof d.binding.type === 'function' && hooksOf(d.binding.type) !== undefined)
          .map(d => ({ key: d.key, ctor: d.binding.type as Function }))
      : this.#hookBindings

    for (const { key, ctor } of candidates) {
      const hooks = hooksOf(ctor)
      if (hooks === undefined) {
        continue
      }

      // Re-fetch the compiled registry binding by key (it carries the factory after init). This iterates
      // the registry, so it also finds label-indexed beans (e.g. controllers) that `get(key)`/`wrap(key)`
      // cannot resolve directly.
      const binding = this.#container.getBindingsBy(d => d.key === key)[0]?.binding
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
        invoke(() => (instance as Record<string | symbol, () => unknown>)[method]())),
      ...this.#hooks.listenersFor(event).map(listener => invoke(() => listener(this))),
    ]

    for (const result of await Promise.allSettled(calls)) {
      if (result.status === 'rejected') {
        errors.push(result.reason)
      }
    }
  }
}

/** A headless application: DI container + lifecycle, no serving platform. */
export class Application extends BaseApplication {}

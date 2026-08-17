import type { ApplicationEvent } from './decorators/lifecycle_registry.js'

/** A programmatic lifecycle listener. Receives the application instance. */
export type ApplicationListener<A> = (app: A) => void | Promise<void>

/**
 * Registry of programmatic application lifecycle listeners, mirroring di's `HookListener`
 * API (`on`/`once`/`off`, single-registration guard). Generic over the application type `A` so listeners
 * receive the concrete app. The application owns dispatch — it reads {@link listenersFor} and awaits each,
 * applying the per-event error policy.
 */
export class ApplicationHooks<A> {
  readonly #listeners = new Map<ApplicationEvent, Map<ApplicationListener<A>, ApplicationListener<A>>>()

  /** Registers a listener for an event. Throws if the same listener is already registered for it. */
  on(event: ApplicationEvent, listener: ApplicationListener<A>): this {
    const map = this.#listeners.get(event)
    if (map) {
      if (map.has(listener)) {
        throw new Error(`Cannot register listener for event "${event}": a listener is already registered`)
      }
      map.set(listener, listener)
      return this
    }

    this.#listeners.set(event, new Map([[listener, listener]]))
    return this
  }

  /** Registers a listener that is removed after it runs once. */
  once(event: ApplicationEvent, listener: ApplicationListener<A>): this {
    const existing = this.#listeners.get(event)
    if (existing?.has(listener)) {
      throw new Error(`Cannot register listener for event "${event}": a listener is already registered`)
    }

    const wrapper: ApplicationListener<A> = app => {
      this.off(event, listener)
      return listener(app)
    }

    if (existing) {
      existing.set(listener, wrapper)
      return this
    }

    this.#listeners.set(event, new Map([[listener, wrapper]]))
    return this
  }

  /** Removes a previously registered listener. */
  off(event: ApplicationEvent, listener: ApplicationListener<A>): this {
    const map = this.#listeners.get(event)
    map?.delete(listener)
    if (map?.size === 0) {
      this.#listeners.delete(event)
    }
    return this
  }

  /** The listeners registered for an event, in registration order (for the application to dispatch). */
  listenersFor(event: ApplicationEvent): ApplicationListener<A>[] {
    const map = this.#listeners.get(event)
    return map ? [...map.values()] : []
  }
}

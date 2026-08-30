import { notNil } from './internal/util/assert/index.js'
import { Binding } from './binding.js'
import { InjectionToken } from './key.js'

/**
 * Represents a set of hooks that can be used to listen to events within a {@link Container} instance.
 */
interface Hooks {
  onSetup: { key: InjectionToken, binding: Binding }

  onBindingRegistered: { key: InjectionToken, binding: Binding }

  onBindingNotRegistered: { key: InjectionToken, binding: Binding }

  onSetupComplete: {}

  onModuleRegistered: { name: string, index: number }

  onModuleRegistrationFailed: { name: string, index: number, error: Error }

  onDisposed: {}

  onBindingInitialized: { key: InjectionToken, binding: Binding, instance: unknown, async: boolean }

  onBindingInitializationFailed: { key: InjectionToken, binding: Binding, error: unknown, async: boolean }
}

/**
 * HookListener allows listening to events within a {@link Container} instance.
 */
export class HookListener {
  private readonly _listeners = new Map<keyof Hooks, Map<Function, (args: any) => void>>()

  get [Symbol.toStringTag]() {
    return HookListener.name
  }

  /**
   * Emits an event.
   *
   * @param event - The event to emit.
   * @param args - The arguments to pass to the event listener.
   *
   * @returns `true` if the event was emitted, `false` otherwise.
   */
  emit<E extends keyof Hooks>(event: E, args?: Hooks[E]): boolean {
    notNil(event, `Event name must not be null or undefined`)

    const eventMap = this._listeners.get(event)

    if (eventMap?.size) {
      for (const fn of eventMap.values()) {
        fn(args)
      }

      return true
    }

    return false
  }

  /**
   * Registers a listener for an event.
   *
   * @param event - The event to listen to.
   * @param listener - The listener function.
   *
   * @returns The {@link HookListener} instance.
   */
  on<E extends keyof Hooks>(event: E, listener: (args: Hooks[E]) => void): this {
    notNil(event, `Event name must not be null or undefined`)
    notNil(listener, `Listener function must not be null or undefined`)

    const eventMap = this._listeners.get(event)

    if (eventMap) {
      if (eventMap.has(listener)) {
        throw new Error(`Cannot register listener for event "${String(event)}": a listener is already registered`)
      }

      eventMap.set(listener, listener)

      return this
    }

    this._listeners.set(event, new Map([[listener, listener]]))

    return this
  }

  /**
   * Registers a listener for an event that will be called only once.
   *
   * @param event - The event to listen to.
   * @param listener - The listener function.
   *
   * @returns The {@link HookListener} instance.
   */
  once<E extends keyof Hooks>(event: E, listener: (args: Hooks[E]) => void): this {
    notNil(event, `Event name must not be null or undefined`)
    notNil(listener, `Listener function must not be null or undefined`)

    const eventMap = this._listeners.get(event)

    if (eventMap?.has(listener)) {
      throw new Error(`Cannot register listener for event "${String(event)}": a listener is already registered`)
    }

    const fn = (args: Hooks[E]): void => {
      listener(args)
      const map = this._listeners.get(event)
      map?.delete(listener)
      if (map?.size === 0) {
        this._listeners.delete(event)
      }
    }

    if (eventMap) {
      eventMap.set(listener, fn)

      return this
    }

    this._listeners.set(event, new Map([[listener, fn]]))

    return this
  }

  /**
   * Removes a listener for an event.
   *
   * @param event - The event to remove the listener from.
   * @param listener - The listener function to remove.
   *
   * @returns The {@link HookListener} instance.
   */
  off<E extends keyof Hooks>(event: E, listener: (args: Hooks[E]) => void): this {
    notNil(event, `Event name must not be null or undefined`)
    notNil(listener, `Listener function must not be null or undefined`)

    const map = this._listeners.get(event)
    map?.delete(listener)

    if (map?.size === 0) {
      this._listeners.delete(event)
    }

    return this
  }

  /**
   * Removes all listeners for an event.
   *
   * @param event - The event to remove all listeners from.
   *
   * @returns The {@link HookListener} instance.
   */
  removeAllListeners<E extends keyof Hooks>(event: E): this {
    this._listeners.delete(notNil(event, `Event name must not be null or undefined`))
    return this
  }
}

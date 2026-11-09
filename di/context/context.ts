declare const kContextKeyType: unique symbol

/**
 * A slot of an {@link ExecutionContext}, typed by the value it holds. Create one with {@link contextKey}.
 */
export type ContextKey<T> = symbol & { readonly [kContextKeyType]?: T }

/**
 * Creates a {@link ContextKey}. Two calls with the same description make two distinct slots.
 */
export function contextKey<T>(description: string): ContextKey<T> {
  return Symbol(description) as ContextKey<T>
}

/**
 * An immutable set of slots carried along one asynchronous continuation by a {@link ContextStorage}.
 *
 * {@link ExecutionContext.with} and {@link ExecutionContext.without} return a new context and leave this one as it
 * was, so a frame started inside another extends it without changing what the outer frame sees.
 */
export class ExecutionContext {
  /** The context with no slot set. */
  static readonly ROOT: ExecutionContext = new ExecutionContext(new Map())

  readonly #values: ReadonlyMap<symbol, unknown>

  private constructor(values: ReadonlyMap<symbol, unknown>) {
    this.#values = values
  }

  get<T>(key: ContextKey<T>): T | undefined {
    return this.#values.get(key) as T | undefined
  }

  with<T>(key: ContextKey<T>, value: T): ExecutionContext {
    const values = new Map(this.#values)
    values.set(key, value)
    return new ExecutionContext(values)
  }

  without<T>(key: ContextKey<T>): ExecutionContext {
    if (!this.#values.has(key)) {
      return this
    }
    const values = new Map(this.#values)
    values.delete(key)
    return new ExecutionContext(values)
  }
}

/**
 * Carries an {@link ExecutionContext} along asynchronous continuations: the shape of `AsyncLocalStorage` from
 * `node:async_hooks`, which satisfies it as it is.
 *
 * It is also the injection key. On Node, every container binds a storage of its own under it unless the application
 * binds one: `container.bind(ContextStorage, t => t.toValue(new AsyncLocalStorage()))`. Read the bound one with
 * `container.contextStorage`.
 */
export abstract class ContextStorage {
  /** Runs `fn` with `context` as the store of every continuation it starts. */
  abstract run<R>(context: ExecutionContext, fn: () => R): R

  /** The context of the current continuation, `undefined` outside every `run`. */
  abstract getStore(): ExecutionContext | undefined
}

let defaultStorage: (() => ContextStorage) | undefined

/**
 * Sets how every container built afterwards creates its default {@link ContextStorage}. The Node entry calls it once
 * at load; without it, a container binds no default.
 */
export function setDefaultContextStorage(factory: () => ContextStorage): void {
  defaultStorage = factory
}

/** A new default storage, or `undefined` when the runtime registered none. */
export function newDefaultContextStorage(): ContextStorage | undefined {
  return defaultStorage?.()
}

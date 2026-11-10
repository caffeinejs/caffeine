declare const kContextKeyType: unique symbol

/**
 * Phantom brand that attaches the value type to a {@link ContextKey}. Invariant, so a key never widens: a
 * `ContextKey<string>` is not a `ContextKey<string | number>`.
 */
export interface ContextKeyBrand<in out T> {
  // Taken and returned, so the brand is invariant structurally too: `in out` alone does not hold through `symbol & …`.
  readonly [kContextKeyType]: (value: T) => T
}

/**
 * A slot of an {@link ExecutionContext}, typed by the value it holds. Create one with {@link contextKey}.
 */
export type ContextKey<T> = symbol & ContextKeyBrand<T>

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
 * On Node, every container makes a storage of its own; `container.bindContextStorage(storage)` replaces it before
 * the container compiles. Read the container's with `container.contextStorage`.
 */
export interface ContextStorage {
  /** Runs `fn` with `context` as the store of every continuation it starts. */
  run<R>(context: ExecutionContext, fn: () => R): R

  /** The context of the current continuation, `undefined` outside every `run`. */
  getStore(): ExecutionContext | undefined
}

let defaultStorage: (() => ContextStorage) | undefined

/**
 * Sets how every container built afterwards creates its default {@link ContextStorage}. The Node entry calls it once
 * at load; without it, a container makes none.
 */
export function setDefaultContextStorage(factory: () => ContextStorage): void {
  defaultStorage = factory
}

/** A new default storage, or `undefined` when the runtime registered none. */
export function newDefaultContextStorage(): ContextStorage | undefined {
  return defaultStorage?.()
}

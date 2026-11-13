import { notNil } from './internal/util/assert/index.js'

declare const kContextKeyType: unique symbol

/**
 * Phantom brand that attaches the value type to a {@link ContextKey}. Invariant, so a key never widens: a
 * `ContextKey<string>` is not a `ContextKey<string | number>`.
 */
export interface ContextKeyBrand<in out T> {
  // Taken and returned, so the brand is invariant structurally too: `in out` alone does not hold through
  // `symbol & …`.
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
 * {@link ExecutionContext.with} returns a new context and leaves this one as it was, so a frame started inside another
 * extends it without changing what the outer frame sees.
 */
export class ExecutionContext {
  /** The context with no slot set. */
  static readonly ROOT: ExecutionContext = new ExecutionContext(undefined, undefined, undefined)

  readonly #key: symbol | undefined
  readonly #value: unknown
  readonly #parent: ExecutionContext | undefined

  private constructor(key: symbol | undefined, value: unknown, parent: ExecutionContext | undefined) {
    this.#key = key
    this.#value = value
    this.#parent = parent
  }

  /** The value of `key` in this context, `undefined` when it is unset. */
  get<T>(key: ContextKey<T>): T | undefined {
    return this.#key === key ? (this.#value as T) : this.#parent?.get(key)
  }

  /**
   * A context with `key` set to `value` and every other slot as here. This one is left as it was.
   *
   * A value `key` held here is shadowed, not dropped: it stays alive as long as the new context does.
   */
  with<T>(key: ContextKey<T>, value: T): ExecutionContext {
    return new ExecutionContext(key, value, this)
  }
}

/**
 * Carries an {@link ExecutionContext} along asynchronous continuations: the shape of `AsyncLocalStorage` from
 * `node:async_hooks`, which satisfies it as it is, without extending it. Each container takes its own from the
 * registered {@link ContextStorageFactory}, which `container.bindContextStorage(...)` replaces before the container
 * initializes. Once it initializes, the container binds it under this class: inject `ContextStorage`.
 *
 * A frame meant to keep the caller's slots extends them: `storage.run((storage.getStore() ?? ExecutionContext.ROOT)
 * .with(key, value), fn)`. One started from {@link ExecutionContext.ROOT} hides them, the request scope included.
 */
export abstract class ContextStorage {
  /** Runs `fn` with `context` as the store of every continuation it starts. */
  abstract run<R>(context: ExecutionContext, fn: () => R): R

  /** The context of the current continuation, `undefined` outside every `run`. */
  abstract getStore(): ExecutionContext | undefined
}

/** Makes the {@link ContextStorage} of one container. */
export type ContextStorageFactory = () => ContextStorage

let factory: ContextStorageFactory | undefined

/**
 * Registers the {@link ContextStorageFactory} every container constructed from now on takes its own storage from. A
 * container takes it once, when it is constructed. Replaces the factory registered before. The Node entry of
 * `@caffeinejs/di` registers one that makes an `AsyncLocalStorage`; elsewhere none is registered, and a container has no
 * context storage and no request scope unless one is bound with `container.bindContextStorage(...)`.
 */
export function bindContextStorageFactory(contextStorageFactory: ContextStorageFactory): void {
  factory = notNil(contextStorageFactory, 'Parameter contextStorageFactory must not be null or undefined')
}

/** A storage from the registered factory, `undefined` when none is registered. */
export function newContextStorage(): ContextStorage | undefined {
  return factory?.()
}

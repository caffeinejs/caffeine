import { errMessage } from '@caffeinejs/std/err'

import { described, ErrInvalidOption } from '../errors.js'

/**
 * What `Resilience(r => r.context(...))` takes: an `AsyncLocalStorage` from `node:async_hooks`, or any object with
 * the same `run` and `getStore`. Give it one of its own: the aspect stores every attempt in it.
 */
export interface ResilienceContextStorage {
  run<R>(store: object, callback: () => R): R
  getStore(): unknown
}

/** One attempt of an annotated method, as the aspect stores it. */
export class Attempt {
  constructor(
    readonly signal: AbortSignal | undefined,
    readonly attempt: number,
  ) {}
}

/** @throws {@link ErrInvalidOption} when `storage` has no `run` or no `getStore` method. */
export function checkedStorage(storage: unknown): ResilienceContextStorage {
  const { run, getStore } = (typeof storage === 'object' && storage !== null ? storage : {}) as Record<string, unknown>
  if (typeof run !== 'function' || typeof getStore !== 'function') {
    throw new ErrInvalidOption(
      errMessage(
        `Cannot use the resilience context storage: it must have run(store, callback) and getStore() methods, got ${described(storage)}`,
      )
        .solutions('Pass an AsyncLocalStorage, such as r.context(new AsyncLocalStorage())')
        .reference('@caffeinejs/resilience', ErrInvalidOption)
        .build(),
    )
  }
  return storage as ResilienceContextStorage
}

/**
 * The attempt of the annotated method the current code runs in, for code anywhere below it: a service the method
 * calls reads the attempt's signal without the method passing it down. Inside nested annotated methods, the
 * innermost attempt is the one read; outside every attempt, both fields are `undefined`.
 *
 * `Resilience()` binds it; it needs a storage, given with `r.context(new AsyncLocalStorage())`.
 *
 * ```ts
 * @Injectable([ResilienceContext])
 * class InventoryHTTP {
 *   constructor(private readonly context: ResilienceContext) {}
 *
 *   get(path: string): Promise<Response> {
 *     return fetch(base + path, { signal: this.context.signal })
 *   }
 * }
 * ```
 */
export class ResilienceContext {
  readonly #storage: ResilienceContextStorage | undefined

  constructor(storage?: ResilienceContextStorage) {
    this.#storage = storage
  }

  /**
   * The attempt's signal, aborted at its time limit or when the caller aborts, or the caller's signal when no time
   * limiter gives the attempt one of its own.
   *
   * @throws {@link ErrInvalidOption} when `Resilience()` was given no storage.
   */
  get signal(): AbortSignal | undefined {
    return this.#current()?.signal
  }

  /**
   * The attempt's number, from 1: the first call is 1, the first retry 2.
   *
   * @throws {@link ErrInvalidOption} when `Resilience()` was given no storage.
   */
  get attempt(): number | undefined {
    return this.#current()?.attempt
  }

  #current(): Attempt | undefined {
    if (this.#storage === undefined) {
      throw new ErrInvalidOption(
        errMessage('Cannot read the resilience context: Resilience() was given no context storage')
          .solutions('Pass one with Resilience(r => r.context(new AsyncLocalStorage()))')
          .reference('@caffeinejs/resilience', ErrInvalidOption)
          .build(),
      )
    }

    const store = this.#storage.getStore()
    return store instanceof Attempt ? store : undefined
  }
}

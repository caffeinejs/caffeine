import { contextKey, type ContextStorage } from '@caffeinejs/di'
import { errMessage } from '@caffeinejs/std/err'

import { described, ErrInvalidOption } from '../errors.js'

/** One attempt of an annotated method, as the aspect stores it. */
export class Attempt {
  constructor(
    readonly signal: AbortSignal | undefined,
    readonly attempt: number,
  ) {}
}

// The slot each attempt's frame holds its attempt in.
export const kResilienceAttempt = contextKey<Attempt>('@caffeinejs/resilience:attempt')

/** @throws {@link ErrInvalidOption} when `storage` has no `run` or no `getStore` method. */
export function checkedStorage(storage: unknown): ContextStorage {
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
  return storage as ContextStorage
}

/**
 * The attempt of the annotated method the current code runs in, for code anywhere below it: a service the method
 * calls reads the attempt's signal without the method passing it down. Inside nested annotated methods, the
 * innermost attempt is the one read; outside every attempt, both fields are `undefined`.
 *
 * `Resilience()` binds it, reading the container's `ContextStorage`, or the storage given with `r.context(...)`.
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
  readonly #storage: ContextStorage | undefined

  constructor(storage?: ContextStorage) {
    this.#storage = storage
  }

  /**
   * The attempt's signal, aborted at its time limit or when the caller aborts, or the caller's signal when no time
   * limiter gives the attempt one of its own. A method called with no signal inside another attempt takes that
   * attempt's signal as its caller's.
   *
   * @throws {@link ErrInvalidOption} when no storage is bound and `Resilience()` was given none.
   */
  get signal(): AbortSignal | undefined {
    return this.#current()?.signal
  }

  /**
   * The attempt's number, from 1: the first call is 1, the first retry 2.
   *
   * @throws {@link ErrInvalidOption} when no storage is bound and `Resilience()` was given none.
   */
  get attempt(): number | undefined {
    return this.#current()?.attempt
  }

  #current(): Attempt | undefined {
    if (this.#storage === undefined) {
      throw new ErrInvalidOption(
        errMessage('Cannot read the resilience context: no ContextStorage is bound and Resilience() was given none')
          .solutions(
            'Bind one with container.bind(ContextStorage, t => t.toValue(new AsyncLocalStorage()))',
            'Pass one with Resilience(r => r.context(new AsyncLocalStorage()))',
          )
          .reference('@caffeinejs/resilience', ErrInvalidOption)
          .build(),
      )
    }

    return this.#storage.getStore()?.get(kResilienceAttempt)
  }
}

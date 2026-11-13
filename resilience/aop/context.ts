import { contextKey, type ContextStorage, ErrNoContextStorage } from '@caffeinejs/di'

/** One attempt of an annotated method, as the aspect stores it. */
export class Attempt {
  constructor(
    readonly signal: AbortSignal | undefined,
    readonly attempt: number,
  ) {}
}

/** The slot of the container's context storage that holds the attempt the current code runs in. */
export const kResilienceAttempt = contextKey<Attempt>('@caffeinejs/resilience:attempt')

/**
 * The attempt of the annotated method the current code runs in, for code anywhere below it: a service the method
 * calls reads the attempt's signal without the method passing it down. Inside nested annotated methods, the
 * innermost attempt is the one read; outside every attempt, both fields are `undefined`.
 *
 * `Resilience()` binds it; it reads the attempt wherever the container has a context storage, as in an application.
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
   * @throws {@link ErrNoContextStorage} when the container has no context storage.
   */
  get signal(): AbortSignal | undefined {
    return this.#current('ResilienceContext.signal')?.signal
  }

  /**
   * The attempt's number, from 1: the first call is 1, the first retry 2.
   *
   * @throws {@link ErrNoContextStorage} when the container has no context storage.
   */
  get attempt(): number | undefined {
    return this.#current('ResilienceContext.attempt')?.attempt
  }

  #current(read: string): Attempt | undefined {
    if (this.#storage === undefined) {
      throw new ErrNoContextStorage(`read ${read}`)
    }

    return this.#storage.getStore()?.get(kResilienceAttempt)
  }
}

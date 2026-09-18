/**
 * What a strategy and the operation see of one call.
 */
export interface ExecutionContext {
  /** The caller's signal, or one a strategy derived with {@link ExecutionContext.with}. */
  readonly signal: AbortSignal | undefined
  /** 1-based; a retry strategy increments it before each attempt. */
  readonly attempt: number
  /**
   * A copy of this context with the given fields replaced; the original is untouched.
   *
   * A strategy that hands the rest of the chain a different signal passes the copy to `next`. A context built any
   * other way, such as a spread or an object literal, cannot reach the operation: the call rejects with
   * `ErrInvalidOption`.
   */
  with(overrides: { signal?: AbortSignal | undefined; attempt?: number }): ExecutionContext
}

/** The protected work. It may return a value or a promise; either way the caller receives a promise. */
export type Operation<T> = (ctx: ExecutionContext) => T | PromiseLike<T>

/**
 * The rest of the chain, from the strategy's point of view. It always returns a promise and never throws
 * synchronously, whatever the strategies inside it do.
 */
export type Next<T> = (ctx: ExecutionContext) => Promise<T>

/**
 * A strategy as a function: it receives the call's context and the rest of the chain, and decides whether, when
 * and how often to call `next`.
 *
 * It is generic per call, so one strategy serves operations of every result type.
 */
export type StrategyFn = <T>(ctx: ExecutionContext, next: Next<T>) => Promise<T>

/** A strategy that carries state, such as a circuit breaker; `run` is called with the object as `this`. */
export interface StrategyObject {
  run: StrategyFn
}

export type Strategy = StrategyFn | StrategyObject

/** A pre-composed chain, as returned by `compose()`. */
export interface Resilient {
  <T>(operation: Operation<T>, signal?: AbortSignal): Promise<T>
}

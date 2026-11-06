/**
 * What a policy and the operation see of one call.
 *
 * An object rather than the bare signal, so a field can be added without changing every operation's signature. A
 * policy that hands the rest of the chain another signal passes a new object, such as `{ ...ctx, signal }`.
 */
export interface CallContext {
  /** The caller's signal, or one a policy derived from it; `undefined` when there is neither. */
  readonly signal: AbortSignal | undefined
}

/**
 * The protected work. `input` is what the caller passed in, handed through every policy untouched, so a chain is
 * built once and serves every call.
 */
export type Operation<T, I = void> = (ctx: CallContext, input: I) => Promise<T>

/** Guards an operation. It is generic per call, so one policy serves operations of every result and input type. */
export type Policy = <T, I = void>(op: Operation<T, I>) => Operation<T, I>

/** A policy that may answer with a value of its own instead of the operation's, such as a fallback. */
export type Recovery<R> = <T, I = void>(op: Operation<T, I>) => Operation<T | R, I>

/**
 * What every built-in instance implements. {@link compose} and {@link decorate} call `wrap()` once, when a chain is
 * built, never per call.
 */
export interface Wrapper {
  wrap<T, I = void>(op: Operation<T, I>): Operation<T, I>
}

/** A {@link Wrapper} that may answer with a value of its own, as a fallback does. */
export interface RecoveryWrapper<R> {
  wrap<T, I = void>(op: Operation<T, I>): Operation<T | R, I>
  /** Type-only and never set: it lets TypeScript infer `R` from an instance. */
  readonly recovers?: R
}

/** What {@link compose} and {@link decorate} accept as a layer: a policy function or an instance. */
export type PolicyLike = Policy | Wrapper

/** What {@link compose} and {@link decorate} accept as an outermost layer that widens the result. */
export type RecoveryLike<R> = Recovery<R> | RecoveryWrapper<R>

import { errMessage } from '@caffeinejs/std/err'

import { ErrInvalidOption } from './errors.js'

/**
 * What a policy and the operation see of one call.
 *
 * An object rather than the bare signal, so a field can be added without changing every operation's signature. A
 * policy that hands the rest of the chain another signal passes a new object, such as `{ ...ctx, signal }`.
 */
export interface CallContext {
  /** The caller's signal, or one a policy derived from it; `undefined` when there is neither. */
  readonly signal: AbortSignal | undefined
  /**
   * Whether an error is the caller's own answer rather than a failing dependency, such as the 404 a request handler
   * throws for a record that does not exist. Such an error passes every policy untouched: a retry does not try again,
   * a circuit breaker records it as ignored, and a fallback does not answer it.
   *
   * A transport integration sets it on the calls of the entrypoints it claims. Nothing sets it on any other call.
   */
  readonly isClientError?: (error: unknown) => boolean
  /**
   * Runs `fn` in the asynchronous context the call was made in. A policy that starts a waiting call later, from another
   * call's continuation or a timer, as a bulkhead or a rate limiter does, starts it through `restore`, so the policies
   * below it and every listener of an event about that call see the caller's context, such as the request it serves.
   *
   * Invoke `fn` synchronously once and return its result. If restoring the context fails before `fn` runs, the
   * waiting call rejects. The resilience aspect sets this when the container has a context storage.
   */
  readonly restore?: <R>(fn: () => R) => R
}

/** Runs queued work through the supplied restore callback and reports whether it started. */
export function restoreWaitingCall(
  ctx: CallContext,
  restore: NonNullable<CallContext['restore']>,
  run: () => void,
  reject: (error: unknown) => void,
): boolean {
  let invoked = false
  let completed = false
  try {
    restore.call(ctx, () => {
      if (invoked) {
        return
      }
      invoked = true
      run()
      completed = true
    })
    if (!completed) {
      throw new ErrInvalidOption(
        errMessage('Cannot restore the waiting call: restore() must run its callback synchronously')
          .reference('@caffeinejs/resilience', ErrInvalidOption)
          .build(),
      )
    }
  } catch (error) {
    if (!completed) {
      reject(error)
    }
  } finally {
    invoked = true
  }
  return completed
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

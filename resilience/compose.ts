import { errMessage } from '@caffeinejs/std/err'

import { ErrInvalidOption } from './errors.js'
import type { CallContext, Operation, Policy, PolicyLike, Recovery, RecoveryLike, Wrapper } from './policy.js'

// Carried by every operation that already returns a promise and never throws, so nothing wraps it twice.
const kLifted = Symbol('@caffeinejs/resilience:lifted')

/** Marks an operation that already returns a promise and never throws, so {@link lift} leaves it as it is. */
export function mark<T, I>(op: Operation<T, I>): Operation<T, I> {
  Object.defineProperty(op, kLifted, { value: true })
  return op
}

/**
 * The operation as one that always returns a promise: a plain value resolves it and a synchronous throw rejects it.
 * An operation already {@link mark}ed is returned as it is.
 */
export function lift<T, I>(op: Operation<T, I>): Operation<T, I> {
  if ((op as { [kLifted]?: true })[kLifted] === true) {
    return op
  }

  return mark((ctx, input) => {
    try {
      const result: unknown = op(ctx, input)
      return (result instanceof Promise ? result : Promise.resolve(result)) as Promise<T>
    } catch (error) {
      return Promise.reject(error)
    }
  })
}

// The only place a function and an instance meet: a function is used as it is, an instance is asked to wrap. Called
// once per layer, when a chain is built.
function toPolicy(layer: unknown, where: string): Policy {
  if (typeof layer === 'function') {
    return layer as Policy
  }
  if (typeof layer === 'object' && layer !== null && typeof (layer as Wrapper).wrap === 'function') {
    const wrapper = layer as Wrapper
    return op => wrapper.wrap(op)
  }

  throw new ErrInvalidOption(
    errMessage(`Cannot ${where} is neither a function nor an object with a wrap() method`)
      .reference('@caffeinejs/resilience', ErrInvalidOption)
      .build(),
  )
}

/**
 * One policy made of several, listed from the outermost to the innermost: `compose(a, b, c)(op)` is `a(b(c(op)))`.
 * Each layer is a policy function or an instance with a `wrap()` method, such as a circuit breaker.
 *
 * Instances are asked to wrap once per operation the policy is applied to, so apply it once and keep the result:
 * {@link decorate} does that for a function.
 *
 * A layer that is not a built-in is lifted: a synchronous throw from what it returns rejects the call instead, so the
 * layers outside it always settle what they started.
 *
 * @throws {@link ErrInvalidOption} when a layer is neither a function nor an object with a `wrap()` method.
 */
export function compose(...policies: PolicyLike[]): Policy
/** With a fallback outermost, the result widens to what it answers with. */
export function compose<R>(recovery: RecoveryLike<R>, ...policies: PolicyLike[]): Recovery<R>
export function compose(...layers: unknown[]): Policy {
  const policies = layers.map((layer, i) => toPolicy(layer, `compose: layer #${i + 1}`))

  return <T, I = void>(op: Operation<T, I>): Operation<T, I> => {
    let inner = lift(op)
    for (let i = policies.length - 1; i >= 0; i--) {
      inner = lift(policies[i]!(inner))
    }
    return inner
  }
}

/**
 * Runs an operation once, with the caller's signal. To guard many calls, apply the policy once and keep the result,
 * or {@link decorate} the function: `run(compose(retries, breaker)(op), signal)` builds the chain on every call.
 *
 * The result is always a promise: a synchronous throw rejects it. An already aborted signal rejects with its reason
 * and runs nothing.
 */
export function run<T>(op: Operation<T>, signal?: AbortSignal): Promise<T> {
  if (signal !== undefined && signal.aborted) {
    return Promise.reject(signal.reason)
  }

  try {
    const result: unknown = op({ signal }, undefined)
    return (result instanceof Promise ? result : Promise.resolve(result)) as Promise<T>
  } catch (error) {
    return Promise.reject(error)
  }
}

export interface DecorateOptions {
  /**
   * The position of the function's signal parameter, counted from 0.
   *
   * Without it, the caller's signal is the first argument that is an `AbortSignal`, and a call that passes none
   * hands the function none. With it, the argument there is the caller's signal, and the function always receives the
   * attempt's signal there, even when the caller passed none, so a time limit reaches it.
   */
  readonly signalAt?: number
}

/**
 * Guards a function with a policy and keeps its signature: the chain is built once, here, and serves every call.
 *
 * The caller's signal starts the call: an aborted one rejects with its reason. Where a policy hands the attempt
 * another signal, such as a time limiter, the function receives that signal in place of the caller's. `this` is not
 * kept: pass a bound method, `decorate(policy, client.get.bind(client))`.
 *
 * @throws {@link ErrInvalidOption} when the policy is neither a function nor an object with a `wrap()` method, `fn`
 * is not a function, or `signalAt` is not an integer of at least 0.
 */
export function decorate<A extends unknown[], T>(
  policy: PolicyLike,
  fn: (...args: A) => Promise<T>,
  options?: DecorateOptions,
): (...args: A) => Promise<T>
/** With a fallback outermost, the result widens to what it answers with. */
export function decorate<A extends unknown[], T, R>(
  recovery: RecoveryLike<R>,
  fn: (...args: A) => Promise<T>,
  options?: DecorateOptions,
): (...args: A) => Promise<T | R>
export function decorate(
  layer: unknown,
  fn: (...args: unknown[]) => unknown,
  options?: DecorateOptions,
): (...args: unknown[]) => Promise<unknown> {
  const policy = toPolicy(layer, 'decorate: the policy')
  if (typeof fn !== 'function') {
    throw new ErrInvalidOption(
      errMessage(`Cannot decorate: fn must be a function, got ${typeof fn}`)
        .reference('@caffeinejs/resilience', ErrInvalidOption)
        .build(),
    )
  }

  const at = options?.signalAt
  if (at !== undefined && (!Number.isInteger(at) || at < 0)) {
    throw new ErrInvalidOption(
      errMessage(`Cannot decorate: signalAt must be an integer of at least 0, got ${String(at)}`)
        .reference('@caffeinejs/resilience', ErrInvalidOption)
        .build(),
    )
  }

  // The innermost layer: it puts the attempt's signal in place and calls the function, lifting what it does.
  const guarded = lift(
    policy(
      mark((ctx: CallContext, args: unknown[]): Promise<unknown> => {
        try {
          const result = fn(...withSignal(args, ctx.signal, at))
          return result instanceof Promise ? result : Promise.resolve(result)
        } catch (error) {
          return Promise.reject(error)
        }
      }),
    ),
  )

  return (...args: unknown[]): Promise<unknown> => {
    const caller = (at === undefined ? args[signalIndex(args)] : args[at]) as AbortSignal | undefined
    if (caller !== undefined && caller.aborted) {
      return Promise.reject(caller.reason)
    }

    return guarded({ signal: caller }, args)
  }
}

// The index of the first argument that is an `AbortSignal`, or -1.
export function signalIndex(args: readonly unknown[]): number {
  for (let i = 0; i < args.length; i++) {
    if (args[i] instanceof AbortSignal) {
      return i
    }
  }
  return -1
}

/**
 * The arguments with `signal` in the signal's place: at `at`, or where the first `AbortSignal` is. The same array
 * when it already holds that signal there, or when there is no place for one.
 */
export function withSignal(args: unknown[], signal: AbortSignal | undefined, at: number | undefined): unknown[] {
  const i = at ?? signalIndex(args)
  if (i === -1 || args[i] === signal) {
    return args
  }

  const copy = args.slice()
  copy[i] = signal
  return copy
}

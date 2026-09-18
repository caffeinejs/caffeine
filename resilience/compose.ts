import { abortReason } from './abort.js'
import { ErrInvalidOption } from './errors.js'
import type { ExecutionContext, Next, Operation, Resilient, Strategy, StrategyFn } from './strategy.js'

// The one context class, so every call has the same shape. `attempt` is written by the retry strategy. The
// operation rides along in a private field so the chain can be built once and reused for every operation; a
// spread or literal copy cannot carry it, which is how a context not made by `with()` is caught.
class Context implements ExecutionContext {
  signal: AbortSignal | undefined
  attempt = 1
  readonly #operation: Operation<unknown>

  constructor(operation: Operation<unknown>, signal: AbortSignal | undefined) {
    this.#operation = operation
    this.signal = signal
  }

  with(overrides: { signal?: AbortSignal | undefined; attempt?: number }): ExecutionContext {
    const copy = new Context(this.#operation, 'signal' in overrides ? overrides.signal : this.signal)
    copy.attempt = overrides.attempt ?? this.attempt
    return copy
  }

  static readonly invoke = (ctx: ExecutionContext): Promise<unknown> => {
    if (typeof ctx !== 'object' || ctx === null || !(#operation in ctx)) {
      return Promise.reject(
        new ErrInvalidOption(
          'Cannot run the operation: the context was not created by runWith(), compose() or ctx.with()',
        ),
      )
    }

    try {
      return Promise.resolve(ctx.#operation(ctx))
    } catch (error) {
      return Promise.reject(error)
    }
  }
}

// A strategy's return value as a promise. It runs after the strategy has returned, so it is never a frame of it. The
// built-in strategies use it on what their own `next` returns.
export function settled<T>(result: T | Promise<T>): Promise<T> {
  return result instanceof Promise ? result : Promise.resolve(result)
}

// Stands in for the first strategy when there is none, so the entry always calls one.
const passThrough: StrategyFn = (ctx, next) => next(ctx)

function isStrategy(value: unknown): value is Strategy {
  return (
    typeof value === 'function' ||
    (typeof value === 'object' && value !== null && typeof (value as { run?: unknown }).run === 'function')
  )
}

function isSignal(value: unknown): value is AbortSignal {
  return typeof value === 'object' && value !== null && typeof (value as { aborted?: unknown }).aborted === 'boolean'
}

// The only frame between two strategies. It turns a synchronous throw or a plain value from the strategy into a
// promise, so every `next` keeps its contract and a strategy that took a permit or counted an attempt always gets to
// settle it. The `try` stays here: a helper that called the strategy would add a frame to every stack trace. An
// object strategy is called as a method, so no bound function is created.
function link(strategy: Strategy, next: Next<any>): Next<any> {
  if (typeof strategy === 'function') {
    return ctx => {
      try {
        return settled(strategy(ctx, next))
      } catch (error) {
        return Promise.reject(error)
      }
    }
  }

  const object = strategy
  return ctx => {
    try {
      return settled(object.run(ctx, next))
    } catch (error) {
      return Promise.reject(error)
    }
  }
}

// Every argument is checked before anything is built, so the first invalid one is the one reported.
function validate(strategies: ArrayLike<unknown>, count: number): void {
  for (let i = 0; i < count; i++) {
    if (!isStrategy(strategies[i])) {
      throw new ErrInvalidOption(
        `Cannot compose: strategy #${i + 1} is neither a function nor an object with a run() method`,
      )
    }
  }
}

// The chain below the first strategy, which the entry calls itself.
function chainOf(strategies: ArrayLike<unknown>, from: number, count: number): Next<any> {
  let chain: Next<any> = Context.invoke
  for (let i = count - 1; i >= from; i--) {
    chain = link(strategies[i] as Strategy, chain)
  }

  return chain
}

/**
 * Builds the chain once and returns a function that runs an operation through it. Strategies are listed from the
 * outermost to the innermost: `compose(a, b)(op)` runs `a(b(op))`.
 *
 * Use it wherever the same strategies protect many calls; {@link runWith} rebuilds the chain on every call.
 *
 * @throws {@link ErrInvalidOption} when an argument is neither a function nor an object with a `run` method.
 */
export function compose(...strategies: Strategy[]): Resilient {
  validate(strategies, strategies.length)
  const first = strategies.length === 0 ? passThrough : strategies[0]
  const next = chainOf(strategies, 1, strategies.length)

  return <T>(operation: Operation<T>, signal?: AbortSignal): Promise<T> => {
    if (signal !== undefined && signal.aborted) {
      return Promise.reject(abortReason(signal))
    }

    // The first strategy is called here, not through a link, so the entry is the only frame above it.
    const ctx = new Context(operation as Operation<unknown>, signal)
    try {
      return settled(typeof first === 'function' ? first(ctx, next) : first.run(ctx, next)) as Promise<T>
    } catch (error) {
      return Promise.reject(error)
    }
  }
}

/**
 * Runs an operation through the given strategies, listed from the outermost to the innermost:
 * `runWith(op, retries, breaker)` retries around the breaker. An `AbortSignal`, or `undefined`, may follow the
 * strategies.
 *
 * The result is always a promise; the operation's value or error, or a strategy's refusal, settles it.
 *
 * @throws {@link ErrInvalidOption} when an argument is neither a strategy nor, in last position, a signal.
 */
export function runWith<T>(operation: Operation<T>, ...strategies: Strategy[]): Promise<T>
export function runWith<T>(operation: Operation<T>, ...args: [...Strategy[], AbortSignal | undefined]): Promise<T>
export function runWith<T>(operation: Operation<T>, ...args: Array<Strategy | AbortSignal | undefined>): Promise<T> {
  let count = args.length
  let signal: AbortSignal | undefined
  if (count > 0) {
    const tail = args[count - 1]
    if (tail === undefined || !isStrategy(tail)) {
      if (tail !== undefined && !isSignal(tail)) {
        throw new ErrInvalidOption('Cannot run: the last argument is neither a strategy nor an AbortSignal')
      }

      signal = tail
      count--
    }
  }

  validate(args, count)
  if (signal !== undefined && signal.aborted) {
    return Promise.reject(abortReason(signal))
  }

  const first = count === 0 ? passThrough : (args[0] as Strategy)
  const next = chainOf(args, 1, count)

  // Called here for the same reason as in compose(): one frame between the caller and the first strategy.
  const ctx = new Context(operation as Operation<unknown>, signal)
  try {
    return settled(typeof first === 'function' ? first(ctx, next) : first.run(ctx, next)) as Promise<T>
  } catch (error) {
    return Promise.reject(error)
  }
}

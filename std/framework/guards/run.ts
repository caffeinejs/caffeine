import type { CompiledGuard } from './compile.js'
import type { BaseGuard, GuardOutcome } from './guard.js'

/**
 * Builds the error a transport answers a denial with: its forbidden status, or its unauthenticated one.
 *
 * Must not throw: it runs in the continuation of an asynchronous guard, where nothing would catch it.
 *
 * @param reason - What the guard gave, or `''` when it gave nothing, a bare `false` included.
 */
export type GuardDenial = (outcome: 'forbidden' | 'unauthenticated', reason: string) => Error

/**
 * Runs `chain` in order against `input` and calls `done` exactly once: with no error when every guard allowed,
 * with `deny`'s error for the first denial, or with what a guard threw or rejected with. Nothing after a denial
 * runs.
 *
 * Not `async`: a chain of synchronous guards reaches `done()` without a microtask.
 */
export function runGuards<I>(
  chain: readonly CompiledGuard<BaseGuard<I>>[],
  input: I,
  deny: GuardDenial,
  done: (err?: Error) => void,
): void {
  step(chain, input, deny, 0, done)
}

function step<I>(
  chain: readonly CompiledGuard<BaseGuard<I>>[],
  input: I,
  deny: GuardDenial,
  start: number,
  done: (err?: Error) => void,
): void {
  for (let i = start; i < chain.length; i++) {
    let result: ReturnType<BaseGuard<I>['guard']>
    try {
      // Resolving is inside the `try`: a request-scoped guard can fail to construct, and after an async
      // guard nothing above this frame would catch it.
      result = resolve(chain[i]).guard(input)
    } catch (err) {
      done(failure(err))
      return
    }

    if (isThenable<boolean | GuardOutcome>(result)) {
      result.then(
        value => {
          const denied = denialOf(value, deny)
          if (denied) {
            done(denied)
            return
          }
          step(chain, input, deny, i + 1, done)
        },
        err => done(failure(err)),
      )
      return
    }

    const denied = denialOf(result, deny)
    if (denied) {
      done(denied)
      return
    }
  }

  done()
}

function resolve<G extends BaseGuard<never>>(entry: CompiledGuard<G>): G {
  return entry.kind === 'instance' ? entry.instance : entry.provider.get()
}

function isThenable<T>(value: unknown): value is PromiseLike<T> {
  return typeof (value as PromiseLike<unknown> | undefined)?.then === 'function'
}

// A falsy error reads as "continue" to the caller, so a guard that failed must never produce one.
function failure(err: unknown): Error {
  return err instanceof Error ? err : new Error('Cannot run guard: it failed with a non-error value', { cause: err })
}

// Total on purpose: nothing may throw from the continuation of an async guard.
function denialOf(result: boolean | GuardOutcome, deny: GuardDenial): Error | undefined {
  if (result === true) {
    return undefined
  }

  if (result === false) {
    return deny('forbidden', '')
  }

  if (result == null) {
    return new Error('Cannot run guard: it returned no result')
  }

  if (result.ok) {
    return undefined
  }

  return deny(result.unauthenticated === true ? 'unauthenticated' : 'forbidden', result.reason || '')
}

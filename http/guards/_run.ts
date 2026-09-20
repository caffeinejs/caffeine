import { ErrHTTPForbidden } from '../error/http.js'
import type { CompiledGuard } from './compile.js'
import type { Guard, GuardContext, GuardInput, GuardResult, GuardReturn, GuardTarget } from './guard.js'

const RESOURCE_FORBIDDEN = 'Resource forbidden'

export function runGuards(
  chain: readonly CompiledGuard[],
  context: GuardContext,
  target: GuardTarget,
  done: (err?: Error) => void,
): void {
  step(chain, { context, target }, 0, done)
}

// Not `async`: a chain of synchronous guards reaches `done()` without a microtask.
function step(chain: readonly CompiledGuard[], input: GuardInput, start: number, done: (err?: Error) => void): void {
  for (let i = start; i < chain.length; i++) {
    let result: GuardReturn
    try {
      // Resolving is inside the `try`: a request-scoped guard can fail to construct, and after an async
      // guard nothing above this frame would catch it.
      result = resolve(chain[i]).guard(input)
    } catch (err) {
      done(failure(err))
      return
    }

    if (isThenable<boolean | GuardResult>(result)) {
      result.then(
        value => {
          const denied = denialOf(value)
          if (denied) {
            done(denied)
            return
          }
          step(chain, input, i + 1, done)
        },
        err => done(failure(err)),
      )
      return
    }

    const denied = denialOf(result)
    if (denied) {
      done(denied)
      return
    }
  }

  done()
}

function resolve(entry: CompiledGuard): Guard {
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
function denialOf(result: boolean | GuardResult): Error | undefined {
  if (result === true) {
    return undefined
  }

  if (result === false) {
    return new ErrHTTPForbidden(RESOURCE_FORBIDDEN)
  }

  if (result == null) {
    return new Error('Cannot run guard: it returned no result')
  }

  return result.ok ? undefined : new ErrHTTPForbidden(result.reason || RESOURCE_FORBIDDEN)
}

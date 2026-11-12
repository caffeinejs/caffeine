/** One entry of a request hook point: answers with nothing, or a thenable the runner waits on. Fails by throwing. */
export type HookEntry<X> = (ctx: X) => void | PromiseLike<void>

/** What a runner stops at: a request already answered. */
export interface Answerable {
  readonly sent: boolean
}

/**
 * Runs `entries` in order, staying synchronous until an entry returns a thenable, and stopping after the first entry
 * that answered. A throw or a rejection is left to the caller.
 */
export function runHooks<X extends Answerable>(entries: readonly HookEntry<X>[], ctx: X): void | Promise<void> {
  return runFrom(entries, ctx, 0)
}

function runFrom<X extends Answerable>(entries: readonly HookEntry<X>[], ctx: X, from: number): void | Promise<void> {
  for (let i = from; i < entries.length; i++) {
    const result = entries[i](ctx)

    if (isThenable(result)) {
      return Promise.resolve(result).then(() => (ctx.sent ? undefined : runFrom(entries, ctx, i + 1)))
    }

    if (ctx.sent) {
      return
    }
  }
}

/** A callback-style hook as an entry, settled synchronously when `done` is called before the hook returns. */
export function callbackEntry<X>(hook: (ctx: X, done: (err?: Error) => void) => void): HookEntry<X> {
  return ctx => {
    let sync = true
    let settled = false
    let failure: Error | undefined
    let resolve: (() => void) | undefined
    let reject: ((err: Error) => void) | undefined

    hook(ctx, err => {
      if (sync) {
        settled = true
        failure = err
      } else if (err === undefined) {
        resolve!()
      } else {
        reject!(err)
      }
    })

    sync = false

    if (settled) {
      if (failure !== undefined) {
        throw failure
      }

      return
    }

    return new Promise<void>((res, rej) => {
      resolve = res
      reject = rej
    })
  }
}

/**
 * Hands `value` to `next` now, or once it settles: the sync-first step every runner chains with. Named so that this
 * module is not itself a thenable, which a `then` export would make it to `await import(...)`.
 */
export function andThen<T, U>(value: T | PromiseLike<T>, next: (value: T) => U | PromiseLike<U>): U | PromiseLike<U> {
  return isThenable(value) ? Promise.resolve(value).then(next) : next(value)
}

/** Whether `value` is a promise or another thenable, which the sync-first runners wait on. */
export function isThenable<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return typeof (value as PromiseLike<T> | null | undefined)?.then === 'function'
}

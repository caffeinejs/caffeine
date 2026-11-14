import { errMessage } from '@caffeinejs/std/err'

import type { AnyAdapterTypes, ContextTypesOf, HTTPSetupContext, IAdapterTypes } from '../../adapter.js'
import type { IContext } from '../../context.js'
import { ErrConfiguration } from '../error/common.js'
import type { RouteDefinition } from './route_definition.js'

/** What goes out as a body: text, bytes, a stream, or none. */
export type SendPayload = string | Uint8Array | ReadableStream<Uint8Array> | null

/** A request hook: runs for each request at its point, and answers with `ctx.body(...)` or fails by throwing. */
export type RequestHook<
  V = Record<never, never>,
  C = Record<never, never>,
  T extends IAdapterTypes = AnyAdapterTypes,
> = (ctx: IContext<V, C, T>) => void | Promise<void>

/**
 * Runs once the request is answered, before the answer goes out: may write the status and headers, and replace the
 * body. Returning `undefined` keeps the payload; returning `null` sends no body.
 */
export type OnSendHook<
  V = Record<never, never>,
  C = Record<never, never>,
  T extends IAdapterTypes = AnyAdapterTypes,
> = (ctx: IContext<V, C, T>, payload: SendPayload) => SendPayload | void | Promise<SendPayload | void>

/**
 * Runs when the request fails, before the error handlers answer it. It observes: it cannot handle the error, and a
 * throw from it is logged while the error goes on to the handlers.
 */
export type OnErrorHook<
  V = Record<never, never>,
  C = Record<never, never>,
  T extends IAdapterTypes = AnyAdapterTypes,
> = (ctx: IContext<V, C, T>, err: Error) => void | Promise<void>

/**
 * The request lifecycle, in the order a request meets it: `onRequest` once the route is matched, `preHandler` right
 * before the handler, `onSend` before the answer goes out, `onResponse` once it has left, and `onError` when the
 * request fails at any point before `onSend`.
 */
export interface RequestHooks<
  V = Record<never, never>,
  C = Record<never, never>,
  T extends IAdapterTypes = AnyAdapterTypes,
> {
  onRequest: RequestHook<V, C, T>
  preHandler: RequestHook<V, C, T>
  onSend: OnSendHook<V, C, T>
  onResponse: RequestHook<V, C, T>
  onError: OnErrorHook<V, C, T>
}

/** The server lifecycle, handed the context of the plugin or application that added the hook. */
export interface ServerHooks<C = unknown> {
  /**
   * Runs once for each route, after every plugin has registered and before the route serves. It reads the route and
   * may add hooks to it with `route.hook(...)`. Synchronous: a returned promise is refused at start-up.
   */
  onRoute: (route: RouteDefinition, kit: HTTPSetupContext<C>) => void
  /** Runs once the server is built, before it serves a request. */
  onReady: (kit: HTTPSetupContext<C>) => void | Promise<void>
  /** Runs once the server has stopped serving and every request in flight has been answered. */
  onClose: (kit: HTTPSetupContext<C>) => void | Promise<void>
}

export type RequestHookName = keyof RequestHooks

export type HookName = RequestHookName | keyof ServerHooks

/** The function a hook at `K` takes. `T` is the adapter it runs on; `never`, for code written for none, is any. */
export type HookFn<K extends HookName, C = unknown, T extends IAdapterTypes = never> = (RequestHooks<
  Record<never, never>,
  C,
  ContextTypesOf<T>
> &
  ServerHooks<C>)[K]

/** The request points, in the order a request meets them. */
export const REQUEST_HOOK_NAMES: readonly RequestHookName[] = [
  'onRequest',
  'preHandler',
  'onSend',
  'onResponse',
  'onError',
]

/** Every point a hook may be added at. */
export const HOOK_NAMES: readonly HookName[] = [...REQUEST_HOOK_NAMES, 'onRoute', 'onReady', 'onClose']

/**
 * Refuses a hook point not in `names`, for a caller the types did not stop.
 *
 * @throws ErrConfiguration naming `where` and the points that exist.
 */
export function assertHookName<K extends string>(name: string, names: readonly K[], where: string): asserts name is K {
  if ((names as readonly string[]).includes(name)) {
    return
  }

  throw new ErrConfiguration(
    errMessage(`Cannot add a hook at "${name}" ${where}: it is not a hook`)
      .solutions(`Use one of ${names.map(n => `"${n}"`).join(', ')}`)
      .reference('@caffeinejs/http', ErrConfiguration)
      .build(),
  )
}

/** One entry of a request hook point: answers with nothing, or a thenable the runner waits on. Fails by throwing. */
export type HookEntry<X> = (ctx: X) => void | PromiseLike<void>

/** One entry of `onSend`: `undefined` keeps the payload. */
export type SendEntry<X> = (ctx: X, payload: SendPayload) => SendPayload | void | PromiseLike<SendPayload | void>

/** One entry of `onError`. */
export type ErrorEntry<X> = (ctx: X, err: Error) => void | PromiseLike<void>

/** What a runner stops at: a request already answered. */
export interface Answerable {
  readonly sent: boolean
}

/**
 * Runs `entries` in order, staying synchronous until an entry returns a thenable, and running none once the request
 * is answered. A throw or a rejection is left to the caller.
 */
export function runHooks<X extends Answerable>(entries: readonly HookEntry<X>[], ctx: X): void | Promise<void> {
  return runFrom(entries, ctx, 0)
}

function runFrom<X extends Answerable>(entries: readonly HookEntry<X>[], ctx: X, from: number): void | Promise<void> {
  for (let i = from; i < entries.length; i++) {
    if (ctx.sent) {
      return
    }

    const result = entries[i](ctx)

    if (isThenable(result)) {
      return Promise.resolve(result).then(() => runFrom(entries, ctx, i + 1))
    }
  }
}

/**
 * Hands `payload` through `entries` in order, sync-first: an entry returning `undefined` keeps it. A throw or a
 * rejection is left to the caller.
 */
export function runSendHooks<X>(
  entries: readonly SendEntry<X>[],
  ctx: X,
  payload: SendPayload,
): SendPayload | Promise<SendPayload> {
  return sendFrom(entries, ctx, payload, 0)
}

function sendFrom<X>(
  entries: readonly SendEntry<X>[],
  ctx: X,
  payload: SendPayload,
  from: number,
): SendPayload | Promise<SendPayload> {
  let current = payload

  for (let i = from; i < entries.length; i++) {
    const result = entries[i](ctx, current)

    if (isThenable(result)) {
      const before = current
      return Promise.resolve(result).then(next => sendFrom(entries, ctx, next === undefined ? before : next, i + 1))
    }

    if (result !== undefined) {
      current = result
    }
  }

  return current
}

/**
 * Runs `entries` in order, sync-first, whether or not the request is answered. A throw or rejection goes to `failed`,
 * and the next entry still runs: one observer that fails does not silence the others.
 */
export function runErrorHooks<X>(
  entries: readonly ErrorEntry<X>[],
  ctx: X,
  err: Error,
  failed: (err: Error) => void,
): void | Promise<void> {
  return runEach(entries as readonly ((ctx: X, arg: unknown) => void | PromiseLike<void>)[], ctx, err, failed)
}

/**
 * Runs every entry in order, sync-first, whether or not the request is answered. A throw or rejection goes to
 * `failed`, and the next entry still runs.
 */
export function runAll<X>(
  entries: readonly HookEntry<X>[],
  ctx: X,
  failed: (err: Error) => void,
): void | Promise<void> {
  return runEach(entries, ctx, undefined, failed)
}

// The runners that never stop at an answered request, nor at a failure.
function runEach<X>(
  entries: readonly ((ctx: X, arg: unknown) => void | PromiseLike<void>)[],
  ctx: X,
  arg: unknown,
  failed: (err: Error) => void,
  from = 0,
): void | Promise<void> {
  for (let i = from; i < entries.length; i++) {
    let result: void | PromiseLike<void>

    try {
      result = entries[i](ctx, arg)
    } catch (failure) {
      failed(asError(failure))
      continue
    }

    if (isThenable(result)) {
      return Promise.resolve(result).then(
        () => runEach(entries, ctx, arg, failed, i + 1),
        (failure: unknown) => {
          failed(asError(failure))
          return runEach(entries, ctx, arg, failed, i + 1)
        },
      )
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

/** What was thrown, as an `Error`: a thrown string or object is wrapped. */
export function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

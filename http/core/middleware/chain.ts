import type { IContext } from '../../context.js'
import { asError, isThenable, type Answerable, type HookEntry, type RequestHookName } from '../lifecycle/lifecycle.js'
import { ErrNextCalledTwice } from './errors.js'
import type { MiddlewareFn, Next } from './middleware.js'
import { pathAfter, prefixMatcher, type PlacedMiddleware } from './path.js'

/** What the chain needs of the request it runs on. */
export interface ChainTarget extends Answerable {
  /** The request path as the router matches it, or the error a malformed one fails with. Computed once per request. */
  normalizedPath(): { path: string; error: Error | undefined }
  /** Where a middleware that fails after it called `next` is reported: nothing waits on it any more. */
  readonly logger: { error(fields: object, message: string): void }
}

interface Layer {
  readonly prefix: ((path: string) => boolean) | undefined
  readonly skip: number | undefined
  readonly handle: MiddlewareFn
}

/**
 * One hook point's middleware of one level, as one entry. It stays synchronous while every middleware calls `next` in
 * the call; otherwise it settles once the last one does, and rejects on `next(err)`. At `onRequest` and `preHandler`,
 * an answer through the context ends the chain; at the later points the request is already answered, and every
 * middleware runs. `undefined` when there is no middleware.
 */
export function compileChain<X extends ChainTarget>(
  middlewares: readonly PlacedMiddleware[],
  point: RequestHookName,
): HookEntry<X> | undefined {
  if (middlewares.length === 0) {
    return undefined
  }

  const layers: Layer[] = middlewares.map(middleware => ({
    prefix: middleware.path === undefined ? undefined : prefixMatcher(middleware.path),
    skip: middleware.skip,
    handle: middleware.handle,
  }))

  const stopsWhenAnswered = point === 'onRequest' || point === 'preHandler'

  return ctx => runChain(layers, ctx, stopsWhenAnswered)
}

function runChain<X extends ChainTarget>(
  layers: readonly Layer[],
  ctx: X,
  stopsWhenAnswered: boolean,
): void | Promise<void> {
  let synchronous = true
  let done = false
  let failure: Error | undefined
  let resolve: (() => void) | undefined
  let reject: ((err: Error) => void) | undefined

  const complete = (err?: Error): void => {
    if (done) {
      return
    }

    done = true

    if (synchronous) {
      failure = err
    } else if (err === undefined) {
      resolve!()
    } else {
      reject!(err)
    }
  }

  // Runs the layers from `from` while each calls `next` within its call; returns once one has not.
  const runFrom = (from: number): void => {
    for (let i = from; i < layers.length; i++) {
      if (done || (stopsWhenAnswered && ctx.sent)) {
        complete()
        return
      }

      const layer = layers[i]

      if (layer.prefix !== undefined) {
        const normalized = ctx.normalizedPath()
        if (normalized.error !== undefined) {
          complete(normalized.error)
          return
        }

        const path = layer.skip === undefined ? normalized.path : pathAfter(normalized.path, layer.skip)
        if (!layer.prefix(path)) {
          continue
        }
      }

      let called = false
      let inCall = true
      let continued = false

      const next: Next = err => {
        if (called) {
          throw new ErrNextCalledTwice()
        }
        called = true

        // `next(null)` goes on, as connect reads it.
        if (err != null) {
          complete(err)
        } else if (inCall) {
          continued = true
        } else {
          runFrom(i + 1)
        }
      }

      try {
        const result: unknown = layer.handle(ctx as unknown as IContext, next)

        if (isThenable(result)) {
          Promise.resolve(result).then(undefined, (err: unknown) => {
            if (called) {
              ctx.logger.error({ err }, 'Middleware failed after it called next')
            } else {
              called = true
              complete(asError(err))
            }
          })
        }
      } catch (err) {
        inCall = false
        called = true
        complete(asError(err))
        return
      }

      inCall = false

      if (!continued) {
        return
      }
    }

    complete()
  }

  runFrom(0)
  synchronous = false

  if (done) {
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

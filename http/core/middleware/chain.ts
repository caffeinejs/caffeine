import type { IContext } from '../../context.js'
import { asError, isThenable, type Answerable, type HookEntry, type RequestHookName } from '../lifecycle/lifecycle.js'
import { configurationError, USE_NODE } from '../server/error.js'
import { ErrNextCalledTwice } from './errors.js'
import type { MiddlewareFn, Next, NodeMiddleware } from './middleware.js'
import { compilePrefix, mountedURL, type PathFlags } from './path.js'
import type { ResolvedMiddleware } from './pipeline.js'

/** What the chain needs of the request it runs on. */
export interface ChainTarget extends Answerable {
  /** The request path as the router matches it, or the error a malformed one fails with. Computed once per request. */
  normalizedPath(): { path: string; error: Error | undefined }
  /** The URL as routed: the base path taken off, the query kept; while a mounted middleware runs, what it is mounted on. */
  readonly req: { readonly url: string }
  /** Sets what `req.url` reads while a middleware mounted under a path runs; `undefined` gives the request its own back. */
  mount(url: string | undefined): void
  /**
   * Runs a Node middleware on the native request with `url` as its URL. `answered` is called when it ended the
   * response, or the client left, without calling `next`.
   */
  runNodeMiddleware(fn: NodeMiddleware, url: string, next: Next, answered: () => void): void
  /** Where a middleware that fails after it called `next` is reported: nothing waits on it any more. */
  readonly logger: { error(fields: object, message: string): void }
}

interface Layer {
  readonly prefix: RegExp | undefined
  readonly handle: MiddlewareFn | undefined
  readonly fn: NodeMiddleware
}

/**
 * One hook point's middleware of one level, as one entry. It stays synchronous while every middleware calls `next` in
 * the call; otherwise it settles once the last one does, rejects on `next(err)`, and settles when a Node middleware
 * answered. At `onRequest` and `preHandler`, an answer through the context ends the chain; at the later points the
 * request is already answered, and every middleware runs. `undefined` when there is no middleware.
 *
 * @throws ErrConfiguration for a Node middleware when `nodeMiddleware` is false: the runtime has no Node request.
 */
export function compileChain<X extends ChainTarget>(
  middlewares: readonly ResolvedMiddleware[],
  point: RequestHookName,
  flags: PathFlags,
  nodeMiddleware: boolean,
  application: string,
): HookEntry<X> | undefined {
  if (middlewares.length === 0) {
    return undefined
  }

  const layers: Layer[] = middlewares.map(middleware => {
    if (middleware.handle === undefined && !nodeMiddleware) {
      throw configurationError(
        `Cannot install the Node middleware "${middleware.fn.name || 'anonymous'}" on the ${application}: it has no Node request`,
        USE_NODE,
      )
    }

    return {
      prefix: middleware.path === undefined ? undefined : compilePrefix(middleware.path),
      handle: middleware.handle,
      fn: middleware.fn,
    }
  })

  const stopsWhenAnswered = point === 'onRequest' || point === 'preHandler'

  return ctx => runChain(layers, ctx, stopsWhenAnswered, flags)
}

function runChain<X extends ChainTarget>(
  layers: readonly Layer[],
  ctx: X,
  stopsWhenAnswered: boolean,
  flags: PathFlags,
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
      let url = ctx.req.url

      if (layer.prefix !== undefined) {
        const normalized = ctx.normalizedPath()
        if (normalized.error !== undefined) {
          complete(normalized.error)
          return
        }

        const match = layer.prefix.exec(normalized.path)
        if (match === null) {
          continue
        }

        url = mountedURL(layer.prefix, ctx.req.url, normalized.path, match, flags)
      }

      let called = false
      let inCall = true
      let continued = false

      const mounted = layer.prefix !== undefined && layer.handle !== undefined

      // The middleware is done with the request, the first time only: a mounted one hands its URL back.
      const release = (): boolean => {
        if (called) {
          return false
        }

        called = true
        if (mounted) {
          ctx.mount(undefined)
        }
        return true
      }

      const next: Next = err => {
        if (!release()) {
          throw new ErrNextCalledTwice()
        }

        // `next(null)` goes on, as connect and Node middleware read it.
        if (err != null) {
          complete(err)
        } else if (inCall) {
          continued = true
        } else {
          runFrom(i + 1)
        }
      }

      try {
        if (layer.handle === undefined) {
          ctx.runNodeMiddleware(layer.fn, url, next, () => complete())
        } else {
          if (mounted) {
            ctx.mount(url)
          }

          const result: unknown = layer.handle(ctx as unknown as IContext, next)

          if (isThenable(result)) {
            Promise.resolve(result).then(undefined, (err: unknown) => {
              if (release()) {
                complete(asError(err))
              } else {
                ctx.logger.error({ err }, 'Middleware failed after it called next')
              }
            })
          }
        }
      } catch (err) {
        inCall = false
        release()
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

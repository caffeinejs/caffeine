import { type InjectionToken, Scopes } from '@caffeinejs/di'

import type { HTTPSetupContext } from '../adapter.js'
import { ErrConfiguration } from '../error/common.js'
import { rawContext } from './_raw_context.js'
import { ErrNextCalledTwice, ErrPipelineSealed } from './errors.js'
import {
  type Middleware,
  type MiddlewareFactory,
  type MiddlewareFn,
  type MiddlewarePath,
  type Next,
  type NodeMiddleware,
  isMiddlewareClass,
  isMiddlewareInstance,
  kMiddlewareHook,
} from './middleware.js'

interface Entry {
  readonly path: MiddlewarePath | undefined
  readonly hook: string | undefined
  readonly target: unknown
}

interface Resolved {
  readonly fn: NodeMiddleware
  readonly hint: unknown
}

/** One middleware as the adapter installs it: resolved, adapted to the Node signature, and placed. */
export interface ResolvedMiddleware {
  /** Where it applies, or `undefined` for every request. */
  readonly path: MiddlewarePath | undefined
  /**
   * The hook `use()` named, else the middleware's own {@link kMiddlewareHook} hint, else `undefined` for the
   * adapter's default. The adapter validates it: nothing here knows which names exist.
   */
  readonly hook: string | undefined
  readonly fn: NodeMiddleware
}

/**
 * The application's middleware pipeline: what `app.use()` registers, resolved once at start-up for the adapter to
 * install.
 *
 * Entries keep their registration order. Which hooks exist, and how a middleware is attached to one, is the
 * adapter's business: `H` is the names its hooks go by.
 */
export class MiddlewarePipeline<H extends string = string> {
  readonly #entries: Entry[] = []
  #sealed = false

  /** Registers `target` at `hook`, optionally restricted to `path`. Throws once the pipeline has been resolved. */
  add(path: MiddlewarePath | undefined, target: unknown, hook?: H): this {
    if (this.#sealed) {
      throw new ErrPipelineSealed()
    }

    this.#entries.push({ path: path === '*' ? undefined : path, hook, target })
    return this
  }

  /**
   * Resolves every entry in registration order, and seals the pipeline.
   *
   * A middleware whose dependency graph reaches request scope is resolved per request; any other container
   * middleware is resolved once, here. Factories run here too, handed `context`.
   */
  resolve(context: HTTPSetupContext): ResolvedMiddleware[] {
    this.#sealed = true

    return this.#entries.map(entry => {
      const resolved = resolve(entry.target, context)
      const hook = entry.hook ?? (resolved.hint === undefined ? undefined : String(resolved.hint))

      return { path: entry.path, hook, fn: resolved.fn }
    })
  }
}

function resolve(target: unknown, context: HTTPSetupContext): Resolved {
  if (isMiddlewareInstance(target)) {
    return { fn: adaptCaffeine((ctx, next) => target.handle(ctx, next)), hint: hintOn(target.constructor) }
  }

  if (typeof target === 'function' && !isMiddlewareClass(target)) {
    if (target.length >= 3) {
      return { fn: target as NodeMiddleware, hint: undefined }
    }
    if (target.length === 1) {
      const produced = (target as MiddlewareFactory)(context)
      return { fn: fromFactory(produced), hint: hintOn(target) }
    }
    return { fn: adaptCaffeine(target as MiddlewareFn), hint: hintOn(target) }
  }

  const container = context.container
  const key = target as InjectionToken<Middleware>

  if (container.hasScopeInGraph(key, Scopes.REQUEST)) {
    const provider = container.wrap<Middleware>(key)
    return {
      fn: adaptCaffeine((ctx, next) => provider.get().handle(ctx, next)),
      hint: typeof key === 'function' ? hintOn(key) : undefined,
    }
  }

  const instance = container.get<Middleware>(key)
  return { fn: adaptCaffeine((ctx, next) => instance.handle(ctx, next)), hint: hintOn(instance.constructor) }
}

function fromFactory(produced: unknown): NodeMiddleware {
  if (isMiddlewareInstance(produced)) {
    return adaptCaffeine((ctx, next) => produced.handle(ctx, next))
  }

  if (typeof produced === 'function' && !isMiddlewareClass(produced)) {
    return produced.length >= 3 ? (produced as NodeMiddleware) : adaptCaffeine(produced as MiddlewareFn)
  }

  throw new ErrConfiguration('Cannot install a middleware: the middleware factory did not return a middleware')
}

function hintOn(holder: object): unknown {
  return (holder as { [kMiddlewareHook]?: unknown })[kMiddlewareHook]
}

function adaptCaffeine(handle: MiddlewareFn): NodeMiddleware {
  return (req, _res, next) => {
    const ctx = rawContext(req)
    if (ctx == null) {
      next()
      return
    }

    let called = false
    const wrapped: Next = err => {
      if (called) {
        throw new ErrNextCalledTwice()
      }
      called = true
      next(err)
    }

    try {
      const result: unknown = handle(ctx, wrapped)
      if (!called && isThenable(result)) {
        result.then(undefined, (err: unknown) => {
          if (!called) {
            wrapped(err as Error)
          }
        })
      }
    } catch (err) {
      if (!called) {
        next(err as Error)
      } else {
        throw err
      }
    }
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as PromiseLike<unknown> | undefined)?.then === 'function'
}

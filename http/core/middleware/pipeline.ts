import { type InjectionToken, Scopes } from '@caffeinejs/di'
import { errMessage } from '@caffeinejs/std/err'

import type { HTTPSetupContext } from '../../plugin.js'
import { ErrConfiguration } from '../error/common.js'
import type { RequestHookName } from '../lifecycle/lifecycle.js'
import { ErrPipelineSealed } from './errors.js'
import {
  type Middleware,
  type MiddlewareFactory,
  type MiddlewareFn,
  type MiddlewarePath,
  isMiddlewareClass,
  isMiddlewareInstance,
  kMiddlewareHook,
} from './middleware.js'

interface Entry {
  readonly path: MiddlewarePath | undefined
  readonly hook: string | undefined
  readonly target: unknown
  readonly factory: boolean
}

type Resolved = { readonly handle: MiddlewareFn; readonly hint: unknown }

/** One middleware as the engine installs it: resolved, and placed. */
export interface ResolvedMiddleware {
  /** Where it applies, or `undefined` for every request. */
  readonly path: MiddlewarePath | undefined
  /**
   * The hook `use()` named, else the middleware's own {@link kMiddlewareHook} hint, else `undefined` for the
   * default, `onRequest`. The engine refuses a hint that is not a request hook point.
   */
  readonly hook: string | undefined
  readonly handle: MiddlewareFn
}

/**
 * The application's middleware pipeline: what `app.use()` and `app.useFn()` register, resolved once at start-up
 * for the engine to install. Entries keep their registration order.
 */
export class MiddlewarePipeline {
  readonly #entries: Entry[] = []
  #sealed = false

  /** Registers `target` at `hook`, optionally restricted to `path`. Throws once the pipeline has been resolved. */
  add(path: MiddlewarePath | undefined, target: unknown, hook?: RequestHookName): this {
    return this.#add(path, target, hook, false)
  }

  /** Registers a factory that produces middleware once at start-up. */
  addFactory(path: MiddlewarePath | undefined, target: unknown, hook?: RequestHookName): this {
    return this.#add(path, target, hook, true)
  }

  #add(path: MiddlewarePath | undefined, target: unknown, hook: RequestHookName | undefined, factory: boolean): this {
    if (this.#sealed) {
      throw new ErrPipelineSealed()
    }

    this.#entries.push({ path: path === '*' ? undefined : path, hook, target, factory })
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
      const resolved = resolve(entry.target, context, entry.factory)
      const hook = entry.hook ?? (resolved.hint === undefined ? undefined : String(resolved.hint))

      return { path: entry.path, hook, handle: resolved.handle }
    })
  }
}

function resolve(target: unknown, context: HTTPSetupContext, factory: boolean): Resolved {
  if (factory) {
    const produced = (target as MiddlewareFactory)(context)
    return { handle: fromFactory(produced), hint: hintOn(target as object) }
  }

  if (isMiddlewareInstance(target)) {
    return { handle: (ctx, next) => target.handle(ctx, next), hint: hintOn(target.constructor) }
  }

  if (typeof target === 'function' && !isMiddlewareClass(target)) {
    return { handle: target as MiddlewareFn, hint: hintOn(target) }
  }

  const container = context.container
  const key = target as InjectionToken<Middleware>

  if (container.hasScopeInGraph(key, Scopes.REQUEST)) {
    const provider = container.wrap<Middleware>(key)
    return {
      handle: (ctx, next) => provider.get().handle(ctx, next),
      hint: typeof key === 'function' ? hintOn(key) : undefined,
    }
  }

  const instance = container.get<Middleware>(key)
  return { handle: (ctx, next) => instance.handle(ctx, next), hint: hintOn(instance.constructor) }
}

function fromFactory(produced: unknown): MiddlewareFn {
  if (isMiddlewareInstance(produced)) {
    return (ctx, next) => produced.handle(ctx, next)
  }

  if (typeof produced === 'function' && !isMiddlewareClass(produced)) {
    return produced as MiddlewareFn
  }

  throw new ErrConfiguration(
    errMessage('Cannot install a middleware: the middleware factory did not return a middleware')
      .reference('@caffeinejs/http', ErrConfiguration)
      .build(),
  )
}

function hintOn(holder: object): unknown {
  return (holder as { [kMiddlewareHook]?: unknown })[kMiddlewareHook]
}

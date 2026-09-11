import { type Container, type InjectionToken, type Provider, Scopes } from '@caffeinejs/di'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import type { Context } from '../context.js'
import { ErrNextCalledTwice, ErrPipelineSealed } from './errors.js'
import {
  type Middleware,
  type MiddlewareFn,
  type MiddlewareHook,
  type MiddlewareRef,
  type Next,
  isMiddlewareClass,
  isMiddlewareInstance,
} from './middleware.js'

type Handle = (ctx: Context, next: Next) => void

type Chain = (ctx: Context, terminal: Next) => void

interface Entry {
  readonly hook: MiddlewareHook
  readonly ref: MiddlewareRef<any>
  /** Resolved during `resolveAll`, except for request-scoped middlewares, which resolve per request. */
  handle?: Handle
  instance?: Middleware
}

const HOOK_ORDER: readonly Exclude<MiddlewareHook, 'handler'>[] = [
  'onRequest',
  'preParsing',
  'preValidation',
  'preHandler',
]

/**
 * The application's middleware pipeline: what `app.use()` registers, and what the adapter installs.
 *
 * Entries keep their registration order within a group. Groups do not compete: the four hook groups run at
 * Fastify's own lifecycle points, and the `handler` group runs last, immediately before the controller.
 */
export class MiddlewarePipeline {
  readonly #entries: Entry[] = []
  #sealed = false
  #resolved = false
  #requiresRequestScope = false

  /** Registers `ref` at `hook`. Throws once the pipeline has been composed. */
  add(ref: MiddlewareRef<any, any>, hook: MiddlewareHook): this {
    if (this.#sealed) {
      throw new ErrPipelineSealed()
    }

    this.#entries.push({ hook, ref })

    return this
  }

  /** Whether a middleware of type `ctor` is registered — as a class, as an instance, resolved or not. */
  has(ctor: Function): boolean {
    return this.#entries.some(
      entry => entry.ref === ctor || entry.ref instanceof ctor || entry.instance instanceof ctor,
    )
  }

  get size(): number {
    return this.#entries.length
  }

  /**
   * Whether any middleware resolves from request scope, and therefore needs a live request scope around it.
   *
   * Meaningful only after {@link resolveAll}: it is what the graph inspection found. The adapter opens the
   * scope for the controllers that need one, and a middleware is as good a reason as a controller.
   */
  get requiresRequestScope(): boolean {
    return this.#requiresRequestScope
  }

  /**
   * Resolves every entry to something callable.
   *
   * Separate from {@link setupAll} because the adapter needs the answer earlier than it can seal the
   * pipeline: whether a middleware resolves from request scope decides which request-context hook is
   * installed, and that happens before the feature configurers get to see the server. Idempotent.
   *
   * A middleware whose dependency graph reaches request scope is resolved per request instead of here, so
   * it never has a start-up instance.
   */
  resolveAll(container: Container): void {
    if (this.#resolved) {
      return
    }
    this.#resolved = true

    for (const entry of this.#entries) {
      const ref = entry.ref

      if (isMiddlewareInstance(ref)) {
        entry.instance = ref
        entry.handle = (c, next) => ref.handle(c, next)
      } else if (isMiddlewareClass(ref) || typeof ref !== 'function') {
        const key = ref as InjectionToken<Middleware>
        const provider: Provider<Middleware> = container.wrap<Middleware>(key)

        if (container.hasScopeInGraph(key, Scopes.REQUEST)) {
          this.#requiresRequestScope = true
          entry.handle = (c, next) => provider.get().handle(c, next)
          continue
        }

        const instance = provider.get()
        entry.instance = instance
        entry.handle = (c, next) => instance.handle(c, next)
      } else {
        entry.handle = ref as MiddlewareFn
      }
    }
  }

  /** Resolves every entry if needed, then seals the pipeline so further `add()` throws. */
  setupAll(container: Container): void {
    this.resolveAll(container)
    this.#sealed = true
  }

  /**
   * Wraps `dispatch` in the `handler` group.
   *
   * Returns `dispatch` itself when that group is empty, so an application registering no handler middleware
   * pays nothing — not an extra frame, not an extra promise.
   */
  wrapHandler<D extends (...args: any[]) => unknown>(dispatch: D): D {
    const handles = this.#handlesFor('handler')
    if (handles.length === 0) {
      return dispatch
    }

    const chain = compose(handles)

    return ((...args: unknown[]) => {
      const request = args[0] as FastifyRequest
      const ctx = request.httpContext
      let sync = true
      let continued = false
      let value: unknown
      let resolveAsync: ((v: unknown) => void) | undefined
      let rejectAsync: ((e: unknown) => void) | undefined

      const terminal: Next = err => {
        if (err) {
          if (sync) {
            throw err
          }
          rejectAsync!(err)
          return
        }
        continued = true
        try {
          const result = dispatch(...args)
          if (sync) {
            value = result
          } else {
            resolveAsync!(result)
          }
        } catch (error) {
          if (sync) {
            throw error
          }
          rejectAsync!(error)
        }
      }

      try {
        chain(ctx, terminal)
      } catch (error) {
        if (sync) {
          throw error
        }
        rejectAsync!(error)
      }

      if (continued) {
        return value
      }
      if (ctx.sent) {
        return
      }
      sync = false
      return new Promise((resolve, reject) => {
        resolveAsync = resolve
        rejectAsync = reject
      })
    }) as D
  }

  /** Installs one composed Fastify hook per non-empty hook group. */
  installHooks(server: FastifyInstance): void {
    for (const hook of HOOK_ORDER) {
      const handles = this.#handlesFor(hook)
      if (handles.length === 0) {
        continue
      }

      const chain = compose(handles)

      // Registered in Fastify's callback style, not as an `async` function, and that is the whole point:
      // an async hook returns a promise on every request, so Fastify defers to a microtask even when every
      // middleware in the group ran synchronously. Calling `done()` directly is what a hand-written hook
      // does, and it is the difference between matching one and paying for the abstraction.
      server.addHook(hook, (request: FastifyRequest, _reply: FastifyReply, done: (err?: Error) => void) => {
        // Probe routes are answered without a context — see the adapter's onRequest hook. Building the
        // pipeline for them would tax the most frequently called routes in the process to run middleware
        // over a response the application does not produce.
        const ctx = request.httpContext
        if (ctx == null) {
          done()
          return
        }

        try {
          chain(ctx, done)
        } catch (error) {
          done(error as Error)
        }
      })
    }
  }

  #handlesFor(hook: MiddlewareHook): Handle[] {
    return this.#entries.filter(entry => entry.hook === hook).map(entry => entry.handle!)
  }
}

/**
 * Folds the middlewares into a single call, once, at start-up.
 *
 * The terminal arrives per request because it closes over that request — the controller dispatch in the
 * `handler` group, Fastify's `done` in a hook group.
 *
 * A chain of synchronous middlewares returns synchronously. A middleware that throws synchronously throws
 * out of the chain — which is what both call sites want, since Fastify wraps its hook runner and its route
 * handler in try/catch.
 */
export function compose(handles: readonly Handle[]): Chain {
  if (handles.length === 0) {
    return (_ctx, terminal) => {
      terminal()
    }
  }

  // A single-middleware group is the common case — most applications register one middleware per hook, if
  // any — and it needs neither the index walk nor its closure.
  if (handles.length === 1) {
    const only = handles[0]

    return (ctx, terminal) => {
      invoke(only, ctx, terminal)
    }
  }

  return (ctx, terminal) => {
    const run = (index: number): void => {
      if (index === handles.length) {
        terminal()
        return
      }

      invoke(handles[index], ctx, err => {
        if (err) {
          terminal(err)
          return
        }
        run(index + 1)
      })
    }

    run(0)
  }
}

function invoke(handle: Handle, ctx: Context, next: Next): void {
  let called = false
  const wrapped: Next = err => {
    if (called) {
      throw new ErrNextCalledTwice()
    }
    called = true
    next(err)
  }

  const result: unknown = handle(ctx, wrapped)
  if (!called && isThenable(result)) {
    result.then(undefined, (err: unknown) => {
      if (!called) {
        wrapped(err as Error)
      }
    })
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as PromiseLike<unknown> | undefined)?.then === 'function'
}

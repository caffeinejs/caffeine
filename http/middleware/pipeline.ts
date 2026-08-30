import { type Container, type InjectionToken, type Provider, Scopes } from '@caffeinejs/di'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Context } from '../context.js'
import { type ActionResult, type ActionResultTypes, Responder } from '../response.js'
import { ErrNextCalledTwice, ErrPipelineSealed } from './errors.js'
import {
  type Middleware,
  type MiddlewareFn,
  type MiddlewareHook,
  type MiddlewareRef,
  type MiddlewareSetupContext,
  type Next,
  isMiddlewareClass,
  isMiddlewareInstance,
} from './middleware.js'

/** A middleware reduced to the only thing the chain needs from it. */
type Handle = (ctx: Context, next: Next) => ActionResult

/** The composed chain: the terminal is supplied per request, since it closes over that request. */
type Chain = (ctx: Context, terminal: () => ActionResult) => ActionResult

interface Entry {
  readonly hook: MiddlewareHook
  readonly ref: MiddlewareRef
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
 * Fastify's own lifecycle points, and the `handler` group runs last, wrapped around the controller.
 */
export class MiddlewarePipeline {
  readonly #entries: Entry[] = []
  #sealed = false
  #resolved = false
  #requiresRequestScope = false

  /** Registers `ref` at `hook`. Throws once the pipeline has been composed. */
  add(ref: MiddlewareRef, hook: MiddlewareHook): this {
    if (this.#sealed) {
      throw new ErrPipelineSealed()
    }

    this.#entries.push({ hook, ref })

    return this
  }

  /** Whether a middleware of type `ctor` is registered — as a class, as an instance, resolved or not. */
  has(ctor: Function): boolean {
    return this.#entries.some(entry =>
      entry.ref === ctor
      || entry.ref instanceof ctor
      || entry.instance instanceof ctor)
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
   * Separate from {@link setupAll} because the adapter needs the answer earlier than it can run the setup
   * hooks: whether a middleware resolves from request scope decides which request-context hook is
   * installed, and that happens before the feature configurers get to see the server. Idempotent.
   *
   * A middleware whose dependency graph reaches request scope is resolved per request instead of here, so
   * it never has a start-up instance — and therefore never a `setup()`.
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

  /** Runs every resolved middleware's `setup()`, in registration order, then seals the pipeline. */
  async setupAll(ctx: MiddlewareSetupContext): Promise<void> {
    this.resolveAll(ctx.container)

    for (const entry of this.#entries) {
      await entry.instance?.setup?.(ctx)
    }

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
      return chain(request.httpContext, () => dispatch(...args) as ActionResult)
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
      server.addHook(hook, (request: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void) => {
        // Probe routes are answered without a context — see the adapter's onRequest hook. Building the
        // pipeline for them would tax the most frequently called routes in the process to run middleware
        // over a response the application does not produce.
        const ctx = request.httpContext
        if (ctx == null) {
          done()
          return
        }

        // Set by the terminal step, so it is accurate by the time the chain settles either way.
        let reachedEnd = false

        let result: ActionResult
        try {
          result = chain(ctx, () => {
            reachedEnd = true
            return undefined
          })
        } catch (error) {
          done(error as Error)
          return
        }

        if (isThenable(result)) {
          Promise.resolve(result).then(
            settled => {
              // The chain ran through, so this is not the middleware's response to give. A value returned
              // after `next()` is discarded, exactly as Fastify discards a hook's return value — a hook
              // group cannot alter the handler's result, which is what the `handler` group is for.
              if (reachedEnd) {
                done()
                return
              }

              const answered = this.#answer(ctx, reply, settled)
              if (isThenable(answered)) {
                answered.then(() => undefined, done)
              }
            },
            done,
          )
          return
        }

        if (reachedEnd) {
          done()
          return
        }

        // Short-circuited: the reply is this middleware's to write, and `done` is deliberately not called —
        // sending is how a callback-style hook ends the lifecycle.
        const answered = this.#answer(ctx, reply, result as ActionResultTypes)
        if (isThenable(answered)) {
          answered.then(() => undefined, done)
        }
      })
    }
  }

  // Writes a short-circuiting middleware's result to the reply. Returns a promise only when rendering a
  // Responder needed one, so the caller can decide whether it has anything to wait for.
  #answer(ctx: Context, reply: FastifyReply, result: ActionResultTypes): void | PromiseLike<void> {
    if (reply.sent) {
      return
    }

    if (result instanceof Responder) {
      const rendered = result.respond(ctx)

      if (isThenable(rendered)) {
        return Promise.resolve(rendered).then(value => {
          if (!reply.sent) {
            reply.send(value)
          }
        })
      }

      if (!reply.sent) {
        reply.send(rendered)
      }

      return
    }

    reply.send(result)
  }

  #handlesFor(hook: MiddlewareHook): Handle[] {
    return this.#entries.filter(entry => entry.hook === hook).map(entry => entry.handle!)
  }
}

/**
 * Folds the middlewares into a single call, once, at start-up.
 *
 * The terminal arrives per request because it closes over that request — the controller dispatch in the
 * `handler` group, a no-op that records completion in a hook group.
 *
 * Nothing here creates a promise. A chain of synchronous middlewares returns synchronously, and one that
 * awaits returns whatever the awaiting middleware returned, so the pipeline costs the closures it genuinely
 * needs and nothing else. A middleware that throws synchronously throws out of the chain — which is what
 * both call sites want, since Fastify wraps its hook runner and its route handler in try/catch, and an
 * upstream `try { await next() }` catches it just the same.
 */
export function compose(handles: readonly Handle[]): Chain {
  // The single-middleware group is the common case — one `useAuthenticationAndAuthorization()` produces
  // exactly that — and it needs neither the index walk nor its closure.
  if (handles.length === 1) {
    const only = handles[0]

    return (ctx, terminal) => {
      let called = false

      return only(ctx, () => {
        if (called) {
          throw new ErrNextCalledTwice()
        }
        called = true

        return terminal()
      })
    }
  }

  return (ctx, terminal) => {
    const run = (index: number): ActionResult => {
      if (index === handles.length) {
        return terminal()
      }

      let called = false

      return handles[index](ctx, () => {
        if (called) {
          throw new ErrNextCalledTwice()
        }
        called = true

        return run(index + 1)
      })
    }

    return run(0)
  }
}

/** Whether `value` is promise-like, without the allocation `Promise.resolve` would make to find out. */
function isThenable(value: unknown): value is PromiseLike<ActionResultTypes> {
  return typeof (value as PromiseLike<unknown> | undefined)?.then === 'function'
}

import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'

import { type Container, type InjectionToken, type Provider, Scopes } from '@caffeinejs/di'
import type { ConfigHandle, Configuration } from '@caffeinejs/std/config'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import type { Context } from '../context.js'
import { ErrConfiguration } from '../error/common.js'
import { Keys } from '../symbols.js'
import { ErrNextCalledTwice, ErrPipelineSealed } from './errors.js'
import {
  type Middleware,
  type MiddlewareFn,
  type MiddlewareHook,
  type MiddlewarePath,
  type Next,
  type NodeMiddleware,
  MIDDLEWARE_HOOKS,
  MIDDLEWARE_HOOKS_WITH_PAYLOAD,
  isMiddlewareClass,
  isMiddlewareInstance,
  kMiddlewareHook,
} from './middleware.js'

const require = createRequire(import.meta.url)

interface MiddieEngine {
  use(path: string | string[] | NodeMiddleware, fn?: NodeMiddleware): unknown
  run(req: IncomingMessage, res: ServerResponse, ctx: Next): void
}

const createMiddie = require('@fastify/middie/lib/engine.js') as (
  complete: (err: Error | null | undefined, req: IncomingMessage, res: ServerResponse, done: Next) => void,
) => MiddieEngine

type Handle = (ctx: Context, next: Next) => void

type Spec =
  | { kind: 'node'; fn: NodeMiddleware }
  | { kind: 'caffeine'; fn: MiddlewareFn }
  | { kind: 'instance'; instance: Middleware }
  | { kind: 'token'; key: InjectionToken }
  | { kind: 'factory'; factory: (config: ConfigHandle<unknown>) => unknown }

interface Entry {
  readonly path: MiddlewarePath | undefined
  hook: MiddlewareHook
  readonly explicit: boolean
  readonly spec: Spec
  handle?: Handle
  instance?: Middleware
}

/**
 * The application's middleware pipeline: what `app.use()` registers, and what the adapter installs onto
 * Middie, one engine per Fastify hook that has entries.
 *
 * Entries keep their registration order within a hook. Hooks do not compete: they run at Fastify's own
 * lifecycle points.
 */
export class MiddlewarePipeline {
  readonly #entries: Entry[] = []
  #sealed = false
  #resolved = false
  #requiresRequestScope = false

  /** Registers `target` at `hook`, optionally restricted to `path`. Throws once the pipeline has been composed. */
  add(path: MiddlewarePath | undefined, target: unknown, hook?: MiddlewareHook): this {
    if (this.#sealed) {
      throw new ErrPipelineSealed()
    }

    const spec = classify(target)
    this.#entries.push({
      path: path === '*' ? undefined : path,
      spec,
      explicit: hook !== undefined,
      hook: resolveHook(spec, hook),
    })

    return this
  }

  /** Whether a middleware of type `ctor` is registered — as a class, as an instance, resolved or not. */
  has(ctor: Function): boolean {
    return this.#entries.some(entry => {
      if (entry.spec.kind === 'token') {
        return entry.spec.key === ctor
      }
      if (entry.spec.kind === 'instance') {
        return entry.spec.instance instanceof ctor || entry.instance instanceof ctor
      }
      return entry.instance instanceof ctor
    })
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
   * Resolves every container-backed entry to something callable.
   *
   * Separate from {@link setupAll} because the adapter needs the answer earlier than it can seal the
   * pipeline: whether a middleware resolves from request scope decides which request-context hook is
   * installed, and that happens before the feature configurers get to see the server. Idempotent.
   *
   * A middleware whose dependency graph reaches request scope is resolved per request instead of here, so
   * it never has a start-up instance. Config factories run later, at {@link installHooks}.
   */
  resolveAll(container: Container): void {
    if (this.#resolved) {
      return
    }
    this.#resolved = true

    for (const entry of this.#entries) {
      const spec = entry.spec

      if (spec.kind === 'instance') {
        entry.instance = spec.instance
        entry.handle = (c, next) => spec.instance.handle(c, next)
      } else if (spec.kind === 'token') {
        const key = spec.key as InjectionToken<Middleware>
        const provider: Provider<Middleware> = container.wrap<Middleware>(key)

        if (container.hasScopeInGraph(key, Scopes.REQUEST)) {
          this.#requiresRequestScope = true
          entry.handle = (c, next) => provider.get().handle(c, next)
          continue
        }

        const instance = provider.get()
        entry.instance = instance
        entry.handle = (c, next) => instance.handle(c, next)
        applyResolvedHook(entry)
      } else if (spec.kind === 'caffeine') {
        entry.handle = spec.fn
      }
    }
  }

  /** Resolves every entry if needed, then seals the pipeline so further `add()` throws. */
  setupAll(container: Container): void {
    this.resolveAll(container)
    this.#sealed = true
  }

  /**
   * Installs one Middie engine per non-empty hook group.
   *
   * Registered in Fastify's callback style, not as an `async` function, and that is the whole point: an
   * async hook returns a promise on every request, so Fastify defers to a microtask even when every
   * middleware in the group ran synchronously. Calling `done()` directly is what a hand-written hook does,
   * and it is the difference between matching one and paying for the abstraction.
   */
  installHooks(server: FastifyInstance, _container: Container, configuration: Configuration<unknown>): void {
    for (const hook of MIDDLEWARE_HOOKS) {
      const group = this.#entries.filter(entry => entry.hook === hook)
      if (group.length === 0) {
        continue
      }

      const engine = createMiddie((err, _req, _res, done) => {
        done(err ?? undefined)
      })

      for (const entry of group) {
        const fn = this.#connectFn(entry, configuration)
        const path = entry.path
        if (path === undefined) {
          engine.use(fn)
        } else if (Array.isArray(path)) {
          for (const prefix of path) {
            engine.use(prefix, fn)
          }
        } else {
          engine.use(path as string, fn)
        }
      }

      const run = (request: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void): void => {
        if (rawContext(request.raw) == null) {
          done()
          return
        }

        stampRaw(request, reply)
        engine.run(request.raw, reply.raw, done)
      }

      if (MIDDLEWARE_HOOKS_WITH_PAYLOAD.includes(hook)) {
        server.addHook(hook as 'onSend', (request, reply, _payload, done) => {
          run(request, reply, done)
        })
      } else {
        server.addHook(hook as 'onRequest', (request, reply, done) => {
          run(request, reply, done)
        })
      }
    }
  }

  #connectFn(entry: Entry, configuration: Configuration<unknown>): NodeMiddleware {
    const spec = entry.spec

    if (spec.kind === 'node') {
      return spec.fn
    }

    if (spec.kind === 'factory') {
      return toConnect(spec.factory(configuration.config))
    }

    const handle = entry.handle
    if (handle === undefined) {
      throw new ErrConfiguration('Cannot install a middleware: it was not resolved')
    }

    return adaptCaffeine(handle)
  }
}

function classify(target: unknown): Spec {
  if (isMiddlewareInstance(target)) {
    return { kind: 'instance', instance: target }
  }

  if (isMiddlewareClass(target)) {
    return { kind: 'token', key: target }
  }

  if (typeof target === 'function') {
    if (target.length === 1) {
      return { kind: 'factory', factory: target as (config: ConfigHandle<unknown>) => unknown }
    }
    if (target.length === 2) {
      return { kind: 'caffeine', fn: target as MiddlewareFn }
    }
    if (target.length >= 3) {
      return { kind: 'node', fn: target as NodeMiddleware }
    }
    return { kind: 'caffeine', fn: target as MiddlewareFn }
  }

  return { kind: 'token', key: target as InjectionToken }
}

function resolveHook(spec: Spec, explicit?: MiddlewareHook): MiddlewareHook {
  if (explicit !== undefined) {
    return explicit
  }

  const hinted = hintFromSpec(spec)
  if (hinted === undefined) {
    return 'onRequest'
  }

  return requireHook(hinted)
}

function applyResolvedHook(entry: Entry): void {
  if (entry.explicit || entry.instance === undefined) {
    return
  }

  const hinted = hintOn(entry.instance.constructor)
  if (hinted === undefined) {
    return
  }

  entry.hook = requireHook(hinted)
}

function hintFromSpec(spec: Spec): unknown {
  switch (spec.kind) {
    case 'node':
      return undefined
    case 'caffeine':
      return hintOn(spec.fn)
    case 'factory':
      return hintOn(spec.factory)
    case 'instance':
      return hintOn(spec.instance.constructor)
    case 'token':
      return typeof spec.key === 'function' ? hintOn(spec.key) : undefined
  }
}

function hintOn(holder: object): unknown {
  return (holder as { [kMiddlewareHook]?: unknown })[kMiddlewareHook]
}

function requireHook(value: unknown): MiddlewareHook {
  if (typeof value === 'string' && (MIDDLEWARE_HOOKS as readonly string[]).includes(value)) {
    return value as MiddlewareHook
  }

  throw new ErrConfiguration(`Cannot register a middleware: the hook hint "${String(value)}" is not a middleware hook`)
}

function toConnect(produced: unknown): NodeMiddleware {
  if (isMiddlewareInstance(produced)) {
    return adaptCaffeine((ctx, next) => produced.handle(ctx, next))
  }

  if (typeof produced === 'function') {
    if (isMiddlewareClass(produced)) {
      throw new ErrConfiguration('Cannot install a middleware: the configuration factory did not return a middleware')
    }
    if (produced.length >= 3) {
      return produced as NodeMiddleware
    }
    return adaptCaffeine(produced as MiddlewareFn)
  }

  throw new ErrConfiguration('Cannot install a middleware: the configuration factory did not return a middleware')
}

function adaptCaffeine(handle: Handle): NodeMiddleware {
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

function rawContext(req: IncomingMessage): Context | undefined {
  return (req as IncomingMessage & { [Keys.CONTEXT]?: Context })[Keys.CONTEXT]
}

function stampRaw(request: FastifyRequest, reply: FastifyReply): void {
  const raw = request.raw as IncomingMessage & Record<string, unknown>
  raw.originalUrl = raw.url
  raw.id = request.id
  raw.hostname = request.hostname
  raw.protocol = request.protocol
  raw.ip = request.ip
  raw.ips = request.ips
  raw.log = request.log
  raw.query = request.query
  ;(reply.raw as ServerResponse & { log?: unknown }).log = request.log
  if (request.body !== undefined) {
    raw.body = request.body
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as PromiseLike<unknown> | undefined)?.then === 'function'
}

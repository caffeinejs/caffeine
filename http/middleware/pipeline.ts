import type { IncomingMessage, ServerResponse } from 'node:http'

import { type Container, type InjectionToken, Scopes } from '@caffeinejs/di'
import type { Configuration } from '@caffeinejs/std/config'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import type { Context } from '../context.js'
import { ErrConfiguration } from '../error/common.js'
import { Keys } from '../symbols.js'
import { type Engine, type NormalizationOptions, createEngine } from './_engine.js'
import { ErrNextCalledTwice, ErrPipelineSealed } from './errors.js'
import {
  type Middleware,
  type MiddlewareFn,
  type MiddlewareHook,
  type MiddlewarePath,
  type Next,
  type NodeMiddleware,
  MIDDLEWARE_HOOKS,
  isMiddlewareClass,
  isMiddlewareInstance,
  kMiddlewareHook,
} from './middleware.js'

const HOOKS_WITH_PAYLOAD: ReadonlySet<MiddlewareHook> = new Set(['onError', 'onSend', 'preParsing', 'preSerialization'])

interface Entry {
  readonly path: MiddlewarePath | undefined
  readonly hook: MiddlewareHook | undefined
  readonly target: unknown
}

interface Resolved {
  readonly fn: NodeMiddleware
  readonly hint: unknown
}

/**
 * The application's middleware pipeline: what `app.use()` registers, and what the adapter installs onto
 * Fastify, one chain per hook that has entries.
 *
 * Entries keep their registration order within a hook. Hooks do not compete: they run at Fastify's own
 * lifecycle points.
 */
export class MiddlewarePipeline {
  readonly #entries: Entry[] = []
  #sealed = false

  /** Registers `target` at `hook`, optionally restricted to `path`. Throws once the pipeline has been installed. */
  add(path: MiddlewarePath | undefined, target: unknown, hook?: MiddlewareHook): this {
    if (this.#sealed) {
      throw new ErrPipelineSealed()
    }

    this.#entries.push({ path: path === '*' ? undefined : path, hook, target })
    return this
  }

  /**
   * Resolves every entry, seals the pipeline, and adds one Fastify hook per non-empty hook group.
   *
   * A middleware whose dependency graph reaches request scope is resolved per request; any other container
   * middleware is resolved once, here. Config factories run here too.
   *
   * The hooks are registered in Fastify's callback style, not as `async` functions: an async hook returns a
   * promise on every request, so Fastify defers to a microtask even when every middleware ran synchronously.
   */
  install(server: FastifyInstance, container: Container, configuration: Configuration<unknown>): void {
    this.#sealed = true

    const options = normalizationOptions(server)
    const engines = new Map<MiddlewareHook, Engine>()

    for (const entry of this.#entries) {
      const resolved = resolve(entry.target, container, configuration)
      const hook = entry.hook ?? toHook(resolved.hint)

      let engine = engines.get(hook)
      if (engine === undefined) {
        engine = createEngine(options)
        engines.set(hook, engine)
      }
      engine.use(entry.path, resolved.fn)
    }

    for (const hook of MIDDLEWARE_HOOKS) {
      const engine = engines.get(hook)
      if (engine === undefined) {
        continue
      }

      const run = (request: FastifyRequest, reply: FastifyReply, done: Next): void => {
        if (rawContext(request.raw) == null) {
          done()
          return
        }

        stampRaw(request, reply)
        engine.run(request.raw, reply.raw, done)
      }

      if (HOOKS_WITH_PAYLOAD.has(hook)) {
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
}

function resolve(target: unknown, container: Container, configuration: Configuration<unknown>): Resolved {
  if (isMiddlewareInstance(target)) {
    return { fn: adaptCaffeine((ctx, next) => target.handle(ctx, next)), hint: hintOn(target.constructor) }
  }

  if (typeof target === 'function' && !isMiddlewareClass(target)) {
    if (target.length >= 3) {
      return { fn: target as NodeMiddleware, hint: undefined }
    }
    if (target.length === 1) {
      const produced = (target as (config: unknown) => unknown)(configuration.config)
      return { fn: fromFactory(produced), hint: hintOn(target) }
    }
    return { fn: adaptCaffeine(target as MiddlewareFn), hint: hintOn(target) }
  }

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

  throw new ErrConfiguration('Cannot install a middleware: the configuration factory did not return a middleware')
}

function hintOn(holder: object): unknown {
  return (holder as { [kMiddlewareHook]?: unknown })[kMiddlewareHook]
}

function toHook(hint: unknown): MiddlewareHook {
  if (hint === undefined) {
    return 'onRequest'
  }

  if (typeof hint === 'string' && (MIDDLEWARE_HOOKS as readonly string[]).includes(hint)) {
    return hint as MiddlewareHook
  }

  throw new ErrConfiguration(`Cannot register a middleware: the hook hint "${String(hint)}" is not a middleware hook`)
}

function normalizationOptions(server: FastifyInstance): NormalizationOptions {
  const config = server.initialConfig
  // find-my-way reads `useSemicolonDelimiter` from its options, but its types do not declare it.
  const router: NormalizationOptions = config.routerOptions ?? {}

  return {
    ignoreDuplicateSlashes: router.ignoreDuplicateSlashes ?? config.ignoreDuplicateSlashes,
    ignoreTrailingSlash: router.ignoreTrailingSlash ?? config.ignoreTrailingSlash,
    useSemicolonDelimiter: router.useSemicolonDelimiter ?? config.useSemicolonDelimiter,
  }
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

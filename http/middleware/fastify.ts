import type { IncomingMessage, ServerResponse } from 'node:http'

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { ErrConfiguration } from '../error/common.js'
import { type Engine, type NormalizationOptions, createEngine } from './_engine.js'
import { rawContext } from './_raw_context.js'
import type { Next } from './middleware.js'
import type { ResolvedMiddleware } from './pipeline.js'

/**
 * Where a middleware runs under the Fastify adapter: one of Fastify's request-lifecycle hooks.
 *
 * Defaults to `onRequest`. Hooks cover every route, including ones the framework registers for itself, except
 * probe routes which have no context and are skipped. Use a later hook when the middleware must see a parsed
 * or validated body.
 */
export type FastifyMiddlewareHook =
  | 'onRequest'
  | 'preParsing'
  | 'preValidation'
  | 'preHandler'
  | 'preSerialization'
  | 'onSend'
  | 'onResponse'
  | 'onError'
  | 'onTimeout'

const FASTIFY_MIDDLEWARE_HOOKS: readonly FastifyMiddlewareHook[] = [
  'onRequest',
  'preParsing',
  'preValidation',
  'preHandler',
  'preSerialization',
  'onSend',
  'onResponse',
  'onError',
  'onTimeout',
]

const HOOKS_WITH_PAYLOAD: ReadonlySet<FastifyMiddlewareHook> = new Set([
  'onError',
  'onSend',
  'preParsing',
  'preSerialization',
])

/**
 * Installs resolved middleware on a Fastify server: one Fastify hook per hook that has entries.
 *
 * Entries keep their registration order within a hook. Hooks do not compete: they run at Fastify's own
 * lifecycle points.
 *
 * The hooks are registered in Fastify's callback style, not as `async` functions: an async hook returns a
 * promise on every request, so Fastify defers to a microtask even when every middleware ran synchronously.
 *
 * @throws ErrConfiguration when a middleware names a hook Fastify does not have.
 */
export function installFastifyMiddlewares(server: FastifyInstance, resolved: readonly ResolvedMiddleware[]): void {
  const options = normalizationOptions(server)
  const engines = new Map<FastifyMiddlewareHook, Engine>()

  for (const middleware of resolved) {
    const hook = toHook(middleware.hook)

    let engine = engines.get(hook)
    if (engine === undefined) {
      engine = createEngine(options)
      engines.set(hook, engine)
    }
    engine.use(middleware.path, middleware.fn)
  }

  for (const hook of FASTIFY_MIDDLEWARE_HOOKS) {
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

function toHook(hook: string | undefined): FastifyMiddlewareHook {
  if (hook === undefined) {
    return 'onRequest'
  }

  if ((FASTIFY_MIDDLEWARE_HOOKS as readonly string[]).includes(hook)) {
    return hook as FastifyMiddlewareHook
  }

  throw new ErrConfiguration(`Cannot register a middleware: the hook "${hook}" is not a middleware hook`)
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

import type { IncomingMessage, ServerResponse } from 'node:http'

import { errMessage } from '@caffeinejs/std/err'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { ErrConfiguration } from '../../../core/error/common.js'
import type { Next } from '../../../core/middleware/middleware.js'
import type { PathFlags } from '../../../core/middleware/path.js'
import type { ResolvedMiddleware } from '../../../core/middleware/pipeline.js'
import { rawContext } from '../../../core/middleware/raw_context.js'
import { sendFailed } from '../lifecycle/lifecycle.js'
import { protocolOf } from '../protocol.js'
import { type Engine, createEngine } from './_engine.js'

/**
 * Where a middleware runs under the Fastify adapter: one of Fastify's request-lifecycle hooks.
 *
 * Defaults to `onRequest`. Hooks cover every route, including ones the framework registers for itself, except
 * probe routes which have no context and are skipped. Use a later hook when the middleware must see a parsed
 * or validated body.
 */
export type MiddlewareHook =
  | 'onRequest'
  | 'preParsing'
  | 'preValidation'
  | 'preHandler'
  | 'preSerialization'
  | 'onSend'
  | 'onResponse'
  | 'onError'
  | 'onTimeout'

const MIDDLEWARE_HOOKS: readonly MiddlewareHook[] = [
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

const HOOKS_WITH_PAYLOAD: ReadonlySet<MiddlewareHook> = new Set(['onError', 'onSend', 'preParsing', 'preSerialization'])

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
export function installMiddlewares(server: FastifyInstance, resolved: readonly ResolvedMiddleware[]): void {
  const options = normalizationOptions(server)
  const engines = new Map<MiddlewareHook, Engine>()

  for (const middleware of resolved) {
    const hook = toHook(middleware.hook)

    let engine = engines.get(hook)
    if (engine === undefined) {
      engine = createEngine(options)
      engines.set(hook, engine)
    }
    engine.use(middleware.path, middleware.fn)
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
        // Once an onSend hook failed, its 500 goes out as written: no later onSend runs over it.
        if (hook === 'onSend' && sendFailed(request)) {
          done()
          return
        }

        run(request, reply, done)
      })
    } else {
      server.addHook(hook as 'onRequest', (request, reply, done) => {
        run(request, reply, done)
      })
    }
  }
}

function toHook(hook: string | undefined): MiddlewareHook {
  if (hook === undefined) {
    return 'onRequest'
  }

  if ((MIDDLEWARE_HOOKS as readonly string[]).includes(hook)) {
    return hook as MiddlewareHook
  }

  throw new ErrConfiguration(
    errMessage(`Cannot register a middleware: the hook "${hook}" is not a middleware hook`)
      .reference('@caffeinejs/http', ErrConfiguration)
      .build(),
  )
}

function normalizationOptions(server: FastifyInstance): PathFlags {
  const config = server.initialConfig
  // find-my-way reads `useSemicolonDelimiter` from its options, but its types do not declare it.
  const router: PathFlags = config.routerOptions ?? {}

  return {
    ignoreDuplicateSlashes: router.ignoreDuplicateSlashes ?? config.ignoreDuplicateSlashes,
    ignoreTrailingSlash: router.ignoreTrailingSlash ?? config.ignoreTrailingSlash,
    useSemicolonDelimiter: router.useSemicolonDelimiter ?? config.useSemicolonDelimiter,
  }
}

function stampRaw(request: FastifyRequest, reply: FastifyReply): void {
  const raw = request.raw as IncomingMessage & Record<string, unknown>
  // Kept when already set: Fastify saved the full URL there before a base path was taken off `url`.
  raw.originalUrl ??= raw.url
  raw.id = request.id
  raw.hostname = request.hostname
  raw.protocol = protocolOf(request)
  raw.ip = request.ip
  raw.ips = request.ips
  raw.log = request.log
  raw.query = request.query
  ;(reply.raw as ServerResponse & { log?: unknown }).log = request.log
  if (request.body !== undefined) {
    raw.body = request.body
  }
}

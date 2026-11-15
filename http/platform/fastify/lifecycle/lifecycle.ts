import { Readable } from 'node:stream'

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import type { IContext } from '../../../context.js'
import { newProblem } from '../../../core/error/problem.js'
import type { HookBatch } from '../../../core/lifecycle/batch.js'
import {
  asError,
  isThenable,
  runAll,
  runErrorHooks,
  runHooks,
  runSendHooks,
  type HookEntry,
  type SendEntry,
  type SendPayload,
} from '../../../core/lifecycle/lifecycle.js'
import type { AuthoredHooks } from '../../../core/lifecycle/route_definition.js'
import type { CompiledHooks } from '../../../core/routing/route.js'
import { REPRESENTATION_HEADERS } from '../../../core/server/answer.js'
import { configurationError } from '../../../core/server/error.js'
import { appendVary } from '../../../vary.js'
import type { Context } from '../context.js'
import { encodeProblem } from '../error/error.js'
import { addRouteHook, type AdapterRouteOptions } from '../routing/route_options.js'

// The Caffeine lifecycle on Fastify's hooks, for as long as the Fastify adapter exists. Request hooks become
// callback-style Fastify hooks, so a request whose hooks are all synchronous costs no microtask. `onError` is not a
// Fastify hook here: Caffeine's own error handlers run it, before they resolve the error, as the engine does. One
// difference stays: `ctx.body(...)` inside an `onSend` hook replaces the body here, where the engine refuses it.

/** One `onError` entry as the Fastify mapping runs it: on the request, whose context it reads. */
export type FastifyErrorEntry = (request: FastifyRequest, err: Error) => void | PromiseLike<void>

/** What answers a throw from an `onSend` hook: the body of the 500 that replaces the payload. */
export type SendFailure = (request: FastifyRequest, reply: FastifyReply, err: Error) => string | Promise<string>

type Hook = (...args: never[]) => unknown

const ranOnError = new WeakSet<FastifyRequest>()
const failedSend = new WeakSet<FastifyRequest>()

/** Adds `batch`'s request hooks to `server`, the root or a group's context. `onError` is left to the error handlers. */
export function installHookBatch(server: FastifyInstance, batch: HookBatch, onSendFailed: SendFailure): void {
  // The engine's own plugins see no route registered straight on Fastify, and would leave it unguarded.
  if (batch.engineOnly !== undefined) {
    throw configurationError(
      `Cannot install "${batch.engineOnly.factory}()" from "@caffeinejs/http" on a Fastify application: it runs on ` +
        'the web-standards engine only',
      batch.engineOnly.instead,
    )
  }

  const { request } = batch

  if (request.onRequest.length > 0) {
    server.addHook('onRequest', requestHook(request.onRequest as readonly HookEntry<Context>[]))
  }

  if (request.preHandler.length > 0) {
    server.addHook('preHandler', requestHook(request.preHandler as readonly HookEntry<Context>[]))
  }

  if (request.onSend.length > 0) {
    server.addHook('onSend', sendHook(request.onSend as readonly SendEntry<Context>[], onSendFailed))
  }

  if (request.onResponse.length > 0) {
    server.addHook('onResponse', responseHook(request.onResponse as readonly HookEntry<Context>[]))
  }
}

/** Adds `batch`'s `onReady` and `onClose` to the root instance, once whatever number of groups install the batch. */
export function installServerHooks(root: FastifyInstance, batch: HookBatch, installed: Set<HookBatch>): void {
  if (installed.has(batch)) {
    return
  }

  installed.add(batch)

  if (batch.onReady.length > 0) {
    root.addHook('onReady', async () => {
      for (const onReady of batch.onReady) {
        await onReady(batch.kit)
      }
    })
  }

  if (batch.onClose.length > 0) {
    root.addHook('onClose', async () => {
      for (const onClose of batch.onClose) {
        await onClose(batch.kit)
      }
    })
  }
}

/**
 * Adds one route's own hooks as route-level hooks, which Fastify runs after every shared hook and after the guard hook
 * already on the route: its compiled hooks, then what `onRoute` added.
 */
export function addRouteHooks(
  routeDef: AdapterRouteOptions,
  compiled: CompiledHooks<FastifyRequest> | undefined,
  added: AuthoredHooks,
  onSendFailed: SendFailure,
): void {
  const onRequest = entries(compiled?.onRequest, added.onRequest)
  if (onRequest.length > 0) {
    addRouteHook(routeDef, 'onRequest', requestHook(onRequest) as never)
  }

  const preHandler = entries(compiled?.preHandler, added.preHandler)
  if (preHandler.length > 0) {
    addRouteHook(routeDef, 'preHandler', requestHook(preHandler) as never)
  }

  const onSend = entries(compiled?.onSend, added.onSend) as readonly SendEntry<Context>[]
  if (onSend.length > 0) {
    addRouteHook(routeDef, 'onSend', sendHook(onSend, onSendFailed) as never)
  }

  const onResponse = entries(compiled?.onResponse, added.onResponse)
  if (onResponse.length > 0) {
    addRouteHook(routeDef, 'onResponse', responseHook(onResponse) as never)
  }
}

/** The `onError` entries of `batches`, in order. */
export function batchOnError(batches: readonly HookBatch[]): FastifyErrorEntry[] {
  return batches.flatMap(batch =>
    batch.request.onError.map(fn => (request: FastifyRequest, err: Error) => fn(request.httpContext as never, err)),
  )
}

/** A route's own `onError` entries, compiled then added, as {@link FastifyErrorEntry}s. */
export function routeOnError(
  compiled: CompiledHooks<FastifyRequest> | undefined,
  added: AuthoredHooks,
): FastifyErrorEntry[] {
  return [
    ...(compiled?.onError ?? []).map(
      entry => (request: FastifyRequest, err: Error) => entry(request, request.httpContext as unknown as IContext, err),
    ),
    ...(added.onError ?? []).map(fn => (request: FastifyRequest, err: Error) => fn(request.httpContext as never, err)),
  ]
}

/**
 * Runs `list` once per request: the group's error handler and the global one it falls back to both call this. Marks the
 * request as answering an error. A throw from an entry is logged, and the next entry still runs.
 */
export function runOnErrorOnce(
  request: FastifyRequest,
  list: readonly FastifyErrorEntry[],
  err: Error,
): void | Promise<void> {
  if (ranOnError.has(request)) {
    return
  }

  ranOnError.add(request)

  return runErrorHooks(list, request, err, failure => request.log.error({ err: failure }, 'onError hook failed'))
}

/** Whether the request is answering an error: its `onError` hooks have run. */
export function answeringError(request: FastifyRequest): boolean {
  return ranOnError.has(request)
}

/** Whether an `onSend` hook of the request failed: every later Caffeine `onSend` hook then passes the payload through. */
export function sendFailed(request: FastifyRequest): boolean {
  return failedSend.has(request)
}

/**
 * What answers a throw from an `onSend` hook: logs it, runs the request's `onError` hooks unless an error is already
 * being answered, and replaces the payload with a 500 `ERR_INTERNAL` problem.
 *
 * @param onErrorOf - The `onError` list of the request: its route's, or the root's for a miss.
 */
export function sendFailure(onErrorOf: (request: FastifyRequest) => readonly FastifyErrorEntry[]): SendFailure {
  return (request, reply, err) => {
    failedSend.add(request)
    request.log.error({ err }, 'onSend hook failed')

    const answer = (): string => {
      reply.code(500)
      for (const name of REPRESENTATION_HEADERS) {
        reply.removeHeader(name)
      }

      const { contentType, body } = encodeProblem(request, newProblem({ status: 500, code: 'ERR_INTERNAL' }))
      appendVary(reply, ['Accept'])
      reply.type(contentType)

      return body
    }

    if (answeringError(request)) {
      return answer()
    }

    const ran = runOnErrorOnce(request, onErrorOf(request), err)
    return isThenable(ran) ? Promise.resolve(ran).then(answer) : answer()
  }
}

/** A Fastify `onSend` payload as the engine's: a Node stream as a web one, a `Response` as its body. */
export function toSendPayload(payload: unknown): SendPayload {
  if (payload === undefined || payload === null) {
    return null
  }

  if (typeof payload === 'string' || payload instanceof Uint8Array || payload instanceof ReadableStream) {
    return payload
  }

  if (payload instanceof Response) {
    return payload.body
  }

  if (payload instanceof Readable) {
    return Readable.toWeb(payload) as ReadableStream<Uint8Array>
  }

  return payload as SendPayload
}

/** The engine's payload as Fastify takes it back: bytes that are not a `Buffer` become a view of the same memory. */
export function fromSendPayload(payload: SendPayload): string | Buffer | ReadableStream<Uint8Array> | null {
  if (payload instanceof Uint8Array && !Buffer.isBuffer(payload)) {
    return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)
  }

  return payload as string | Buffer | ReadableStream<Uint8Array> | null
}

// A route's compiled entries, `(req, ctx, ...)`, and what `onRoute` added, `(ctx, ...)`, as entries on the context.
function entries(
  compiled: readonly ((req: FastifyRequest, ctx: IContext, arg: never) => unknown)[] | undefined,
  added: readonly Hook[] | undefined,
): HookEntry<Context>[] {
  const fromCompiled = (compiled ?? []).map(
    entry =>
      ((ctx: Context, arg: never) =>
        entry(ctx.platform.request, ctx as unknown as IContext, arg)) as unknown as HookEntry<Context>,
  )

  return [...fromCompiled, ...((added ?? []) as unknown as HookEntry<Context>[])]
}

// Not called back once a hook answered, as `installMiddlewares` does: the reply is on its way.
function requestHook(list: readonly HookEntry<Context>[]) {
  return (request: FastifyRequest, _reply: FastifyReply, done: (err?: Error) => void): void => {
    const ctx = request.httpContext as Context | null | undefined
    if (ctx == null) {
      done()
      return
    }

    let ran: void | Promise<void>
    try {
      ran = runHooks(list, ctx)
    } catch (err) {
      done(asError(err))
      return
    }

    if (isThenable(ran)) {
      ran.then(
        () => {
          if (!ctx.sent) {
            done()
          }
        },
        (err: unknown) => done(asError(err)),
      )
    } else if (!ctx.sent) {
      done()
    }
  }
}

// Every entry runs; a failure is logged and never ends the request, which has already been answered.
function responseHook(list: readonly HookEntry<Context>[]) {
  return (request: FastifyRequest, _reply: FastifyReply, done: () => void): void => {
    const ctx = request.httpContext as Context | null | undefined
    if (ctx == null) {
      done()
      return
    }

    const ran = runAll(list, ctx, err => request.log.error({ err }, 'onResponse hook failed'))
    if (isThenable(ran)) {
      void ran.then(done)
    } else {
      done()
    }
  }
}

// A throw is answered here, never handed to Fastify, which would run the error handlers and every onSend again.
function sendHook(list: readonly SendEntry<Context>[], onSendFailed: SendFailure) {
  return (
    request: FastifyRequest,
    reply: FastifyReply,
    payload: unknown,
    done: (err: Error | null, payload?: unknown) => void,
  ): void => {
    const ctx = request.httpContext as Context | null | undefined
    if (ctx == null || failedSend.has(request)) {
      done(null, payload)
      return
    }

    const failed = (err: unknown): void => {
      const body = onSendFailed(request, reply, asError(err))
      if (isThenable(body)) {
        void Promise.resolve(body).then(answer => done(null, answer))
      } else {
        done(null, body)
      }
    }

    // Kept by every hook, what Fastify was handed goes back as it was, so a `Response` keeps its status and headers. A
    // Node stream is the exception: its web view has started reading it, and only that view still has all of it.
    const handed = toSendPayload(payload)
    const back = (result: SendPayload): unknown =>
      result === handed && !(payload instanceof Readable) ? payload : fromSendPayload(result)

    let sent: SendPayload | Promise<SendPayload>
    try {
      sent = runSendHooks(list, ctx, handed)
    } catch (err) {
      failed(err)
      return
    }

    if (isThenable(sent)) {
      sent.then(result => done(null, back(result)), failed)
    } else {
      done(null, back(sent))
    }
  }
}

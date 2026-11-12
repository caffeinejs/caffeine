import { errMessage } from '@caffeinejs/std/err'

import type { IContext } from '../../context.js'
import { appendVary } from '../../vary.js'
import { ErrConfiguration } from '../error/common.js'
import { codeForStatus, errorStatus, hasPublicMessage } from '../error/encode.js'
import { resolveByErrorChain } from '../error/handler.js'
import { ErrHTTP } from '../error/http.js'
import { newProblem, type Problem } from '../error/problem.js'
import { andThen, isThenable } from '../lifecycle/lifecycle.js'
import { kErrorUnhandled, type CatchByMap } from '../routing/route.js'
import { answer } from './answer.js'
import type { Context, ServerShared } from './context.js'
import type { RouteStore } from './server.js'

/**
 * Answers `err` on `ctx` in the order Fastify's handlers resolve it: the route's `@CatchWith`, the group's
 * `@CatchWith`, the group's own handler, the global handlers, then the default problem. A throw from a scoped stage
 * goes on to the global handlers; a throw from those is logged and answered with the default problem for it.
 */
export function answerError(shared: ServerShared, ctx: Context, store: RouteStore, err: Error): void | Promise<void> {
  if (ctx.sent) {
    // Answered, then failed: the answer stands, and only the log says what went wrong after it.
    shared.logger.error({ reqId: ctx.req.id, err }, 'Handler failed after its answer was sent')
    return
  }

  let handled: boolean | PromiseLike<boolean>
  try {
    handled = scoped(ctx, store, err)
  } catch (failure) {
    return globalStage(shared, ctx, asError(failure))
  }

  // A scoped handler that threw hands its own error to the global handlers, as Fastify's parent handler takes it.
  if (isThenable(handled)) {
    return Promise.resolve(handled).then(
      done => (done ? undefined : globalStage(shared, ctx, err)),
      (failure: unknown) => globalStage(shared, ctx, asError(failure)),
    )
  }

  return handled ? undefined : globalStage(shared, ctx, err)
}

/** The route's and the group's own handling; `false` when neither took the error. */
function scoped(ctx: Context, store: RouteStore, err: Error): boolean | PromiseLike<boolean> {
  const handler = catchBy(store.route?.catchBy, err) ?? catchBy(store.group?.catchBy, err)

  if (handler !== undefined) {
    return andThen(answer(ctx, handler.get().handle(asIContext(ctx), err)), () => true)
  }

  const groupHandler = store.group?.handleError

  if (groupHandler === undefined) {
    return false
  }

  return andThen(groupHandler(ctx, asIContext(ctx), err), result =>
    result === kErrorUnhandled ? false : andThen(answer(ctx, result), () => true),
  )
}

/** The application-wide handlers, then the default problem: Fastify's global error handler without validation. */
function global(shared: ServerShared, ctx: Context, err: Error): void | Promise<void> {
  const handler = shared.errors.provide(err)

  if (handler !== undefined) {
    return answer(ctx, handler.get().handle(asIContext(ctx), err))
  }

  defaultProblem(shared, ctx, err)
}

/**
 * The problem nothing else answered `err` with: an `ErrHTTP`'s own, a public message, a 4xx's message, or a 5xx that
 * says nothing of its cause.
 */
export function defaultProblem(shared: ServerShared, ctx: Context, err: Error): void {
  const log = shared.logger

  if (err instanceof ErrHTTP) {
    if (err.headers) {
      ctx.headers(err.headers)
    }

    if (err.body === undefined) {
      sendProblem(shared, ctx, err.toProblem(), err)
      return
    }

    // A body the error carried is the author's own and is sent as it stands; the error's status stands over a
    // Response given as that body.
    ctx.answerWithStatus(err.body, err.statusCode)
    return
  }

  // Its message is detail for the log: an issuer, the address a provider could not be reached at.
  if (hasPublicMessage(err)) {
    log[err.statusCode >= 500 ? 'error' : 'info']({ reqId: ctx.req.id, err }, err.message)
    sendProblem(shared, ctx, newProblem({ status: err.statusCode, code: err.code, detail: err.publicMessage }), err)
    return
  }

  const status = errorStatus(err)

  // A 4xx describes what the caller got wrong, so its message is written for them and answers as the detail.
  if (status < 500) {
    log.info({ reqId: ctx.req.id, err }, err.message)

    const headers = (err as { headers?: Record<string, string> }).headers
    if (headers !== undefined) {
      ctx.headers(headers)
    }

    const code = (err as { code?: unknown }).code
    sendProblem(
      shared,
      ctx,
      newProblem({ status, code: typeof code === 'string' ? code : codeForStatus(status), detail: err.message }),
      err,
    )
    return
  }

  // Nothing here was written for a client. It stays in the log, and the response names the status and nothing else.
  log.error({ reqId: ctx.req.id, err }, err.message)
  sendProblem(shared, ctx, newProblem({ status, code: 'ERR_INTERNAL' }), err)
}

/** Answers with `problem`, in the format the request asks for, so the response varies on Accept. */
export function sendProblem(shared: ServerShared, ctx: Context, problem: Problem, err?: Error): void {
  const { contentType, body } = shared.encodeProblem(
    ctx.req.header('accept'),
    asIContext(ctx),
    problem,
    shared.logger,
    err,
  )

  appendVary(ctx, ['Accept'])
  ctx.header('content-type', contentType)
  ctx.status(problem.status)
  ctx.body(body)
}

// The global handlers, with the default problem for whatever they throw.
function globalStage(shared: ServerShared, ctx: Context, err: Error): void | Promise<void> {
  const fallBack = (failure: unknown): void => {
    const thrown = asError(failure)
    shared.logger.error(
      { reqId: ctx.req.id, err: thrown },
      'Cannot handle an error: answering with the default problem',
    )

    if (!ctx.sent) {
      defaultProblem(shared, ctx, thrown)
    }
  }

  try {
    const result = global(shared, ctx, err)
    return isThenable(result) ? Promise.resolve(result).then(undefined, fallBack) : result
  } catch (failure) {
    fallBack(failure)
  }
}

function catchBy(map: CatchByMap | undefined, err: Error): ReturnType<CatchByMap['get']> {
  return map === undefined || map.size === 0 ? undefined : resolveByErrorChain(map, err)
}

// Handed to code typed on `IContext`, which names Fastify's types until the fetch application joins the registry.
function asIContext(ctx: Context): IContext {
  return ctx as unknown as IContext
}

/** The solution every refusal of what the fetch application cannot serve yet offers. */
export const USE_FASTIFY = 'Build the application with createWebApplication() from "@caffeinejs/http/fastify"'

/** An `ErrConfiguration` with its solutions and reference, as the engine writes every start-up refusal. */
export function configurationError(message: string, ...solutions: string[]): ErrConfiguration {
  return new ErrConfiguration(
    errMessage(message)
      .solutions(...solutions)
      .reference('@caffeinejs/http', ErrConfiguration)
      .build(),
  )
}

/** What was thrown, as an `Error`: a thrown string or object is wrapped. */
export function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

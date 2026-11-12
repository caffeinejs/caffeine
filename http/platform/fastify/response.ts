import { Readable } from 'node:stream'

import { payloadOf } from '../../core/server/answer.js'
import { Responder } from '../../response.js'
import type { Context } from './context.js'

/** The part of a reply this module writes to, so a reply of any server parameterization fits. */
interface Reply {
  status(code: number): unknown
  getHeader(name: string): unknown
  header(name: string, value: string): unknown
  hasHeader(name: string): boolean
  send(payload?: Readable): unknown
  readonly statusCode: number
  readonly request: { readonly method: string }
}

/**
 * Whether the request is answered already, so nothing more is sent: through the context, or by Fastify's own 503 for
 * a handler that outlived its timeout. Built once per route or error handler, never per request.
 */
type Answered = (ctx: Context) => boolean

/**
 * What the adapter hands Fastify for what a route's handler or a catch handler answered with: the answer a
 * `Responder` gives in its place, unwrapped once, and an answer given later once it settles, shaped by
 * {@link payloadOf}.
 *
 * The reply itself once `answered`, which is asked before anything runs and again after every wait, so the server
 * waits on the send in flight instead of starting a second over it; and the reply once the empty answer of an answer
 * with no body is on its way.
 */
export function answer(reply: Reply, ctx: Context, result: unknown, answered: Answered, unwrapped = false): unknown {
  if (answered(ctx)) {
    return reply
  }

  // The reply is a thenable too: handed back, the server waits on it, which is what it is for.
  if (result !== reply && typeof (result as PromiseLike<unknown> | null)?.then === 'function') {
    return Promise.resolve(result).then(settled => answer(reply, ctx, settled, answered, unwrapped))
  }

  if (!unwrapped && result instanceof Responder) {
    return answer(reply, ctx, result.respond(ctx), answered, true)
  }

  const payload = payloadOf(reply, result)

  if (payload === undefined) {
    // Fastify's HEAD route writes `Content-Length: 0` for a send with no body, and a 204 or a 304 carries none: a
    // stream, which it drains instead, leaves the length out.
    reply.send(
      reply.request.method === 'HEAD' && (reply.statusCode === 204 || reply.statusCode === 304)
        ? Readable.from([])
        : undefined,
    )
    return reply
  }

  return payload
}

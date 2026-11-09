import type { IncomingMessage } from 'node:http'

import { errorCodes, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'

import type { CaffeineRouteConfig } from './route_config.js'

// Fastify's own `request.signal` and `handlerTimeout` treat the raw request's `close` as the client leaving. Node emits
// it as soon as a body has been read too, so on a request with a body Fastify aborts the signal while the client
// waits, never hears a client that leaves later, and clears the timeout timer before the handler runs.
// fastify/fastify#7069 fixes that upstream.
const kLifetime = Symbol('caffeine.request.lifetime')

type LifetimeCarrier = FastifyRequest & { [kLifetime]: RequestLifetime | null }

/**
 * A request's own signal and timeout: the client leaving is read off the response, which closes before it was ended
 * only when the connection ends.
 */
class RequestLifetime {
  readonly #reply: FastifyReply
  #controller?: AbortController
  #timer?: NodeJS.Timeout
  #watching = false

  constructor(reply: FastifyReply) {
    this.#reply = reply
  }

  get signal(): AbortSignal {
    if (this.#controller !== undefined) {
      return this.#controller.signal
    }

    this.#controller = new AbortController()

    if (this.#left()) {
      this.#controller.abort()
      return this.#controller.signal
    }

    if (this.#reply.raw.writableEnded) {
      // Answered: nothing is left to abort, and nothing will be watched.
      return this.#controller.signal
    }

    this.#watch()
    return this.#controller.signal
  }

  /** Answers the request with Fastify's handler timeout error once `ms` pass, unless it was answered first. */
  arm(ms: number): void {
    const reply = this.#reply

    this.#timer = setTimeout(() => {
      this.#timer = undefined

      if (reply.sent) {
        return
      }

      const err = new errorCodes.FST_ERR_HANDLER_TIMEOUT(ms, reply.request.routeOptions.url)
      this.#abort(err)

      // A `signal` listener may have answered the request itself.
      if (reply.sent) {
        return
      }

      // Under way already, as a stream that wrote its first chunk: an error sent now would write headers twice.
      if (reply.raw.headersSent) {
        reply.raw.destroy(err)
        return
      }

      reply.send(err)
    }, ms)

    this.#watch()
  }

  /** Whether the client has gone: the response ended unfinished, or a request it had not finished sending closed. */
  #left(): boolean {
    const raw = this.#reply.raw
    const req: IncomingMessage = this.#reply.request.raw

    return (destroyed(raw) && !raw.writableEnded) || (destroyed(req) && req.complete !== true) || streamAborted(req)
  }

  #watch(): void {
    if (this.#watching) {
      return
    }

    this.#watching = true
    const res = this.#reply.raw
    const req = this.#reply.request.raw

    // A request with a body closes once the body is read, `complete` by then; it closes unread only when the client
    // goes. An in-process request, which never sets `complete`, closes only when its caller hangs up.
    const onRequestClose = (): void => {
      if (req.complete !== true && !res.writableEnded) {
        this.#abort()
      }
    }

    const onResponseClose = (): void => {
      req.removeListener('close', onRequestClose)
      clearTimeout(this.#timer)
      this.#timer = undefined

      if (!res.writableEnded || streamAborted(req)) {
        this.#abort()
      }
    }

    req.on('close', onRequestClose)
    res.once('close', onResponseClose)
  }

  #abort(reason?: unknown): void {
    // A disconnect has nobody to tell when nobody has read the signal; a timeout creates it, since its reason is what
    // tells a late result from an answer.
    if (this.#controller === undefined && reason === undefined) {
      return
    }

    this.#controller ??= new AbortController()

    if (!this.#controller.signal.aborted) {
      this.#controller.abort(reason)
    }
  }
}

/** Whether a raw request or response is destroyed. HTTP/2's compatibility objects say so through their stream. */
function destroyed(raw: { readonly destroyed?: boolean; readonly stream?: { readonly destroyed: boolean } }): boolean {
  return raw.destroyed ?? raw.stream?.destroyed ?? false
}

/**
 * Whether an HTTP/2 request's stream was reset before its answer was sent. An HTTP/2 response reads as finished once
 * its stream closes, however it closed, so this is what tells a client that cancelled.
 */
function streamAborted(req: { readonly aborted?: boolean; readonly stream?: unknown }): boolean {
  return req.stream !== undefined && req.aborted === true
}

/**
 * Records a route's timeout under its `config.$caffeine`: Fastify copies a route's `config` into the one its requests
 * read, but not what that holds, so the object a route registered with is the one each request finds.
 */
export type RouteTimer = (meta: CaffeineRouteConfig, ms: number) => void

/**
 * Gives every request on `fastify` its own signal and times each route recorded through the returned
 * {@link RouteTimer}, else every route by `serverTimeout`. Call it on the bare server, ahead of every other hook, so
 * the timeout covers them and the body, as Fastify's own covered them.
 */
export function installRequestLifetime(fastify: FastifyInstance, serverTimeout: number | undefined): RouteTimer {
  const fallback = serverTimeout !== undefined && serverTimeout > 0 ? serverTimeout : undefined
  const timeouts = new WeakMap<CaffeineRouteConfig, number>()
  let timed = fallback !== undefined

  fastify.decorateRequest(kLifetime, null)
  fastify.addHook('onRequest', function (request, reply, done) {
    const lifetime = new RequestLifetime(reply)
    ;(request as LifetimeCarrier)[kLifetime] = lifetime

    // Until a route records a timeout, on a server with none, no request looks its route up.
    if (timed) {
      // Absent on the not-found context, which the server's timeout covers alone.
      const meta = (request.routeOptions.config as { $caffeine?: CaffeineRouteConfig }).$caffeine
      const ms = (meta === undefined ? undefined : timeouts.get(meta)) ?? fallback

      if (ms !== undefined) {
        lifetime.arm(ms)
      }
    }

    done()
  })

  return (meta, ms) => {
    timeouts.set(meta, ms)
    timed = true
  }
}

/**
 * The request's signal: aborted when the client leaves before its answer is finished, or with Fastify's
 * `FST_ERR_HANDLER_TIMEOUT` error when its route or server timeout passes first.
 *
 * On a request that did not come through a Caffeine server, this is Fastify's own `request.signal`.
 */
export function requestSignal(request: { readonly signal: AbortSignal }): AbortSignal {
  const lifetime = (request as Partial<LifetimeCarrier>)[kLifetime]
  return lifetime == null ? request.signal : lifetime.signal
}

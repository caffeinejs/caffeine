import type { ByteSize } from '@caffeinejs/std/bytes'

import type { IContextPlatform } from '../../adapter.js'
import type { SendPayload } from '../lifecycle/lifecycle.js'
import type { Next, NodeMiddleware } from '../middleware/middleware.js'

/** The status and headers of an answer, lower-case names. */
export interface ResponseHead {
  readonly status: number
  readonly headers: Readonly<Record<string, string | readonly string[]>>
}

/**
 * What a Node middleware finds on the request beside Node's own members, as a Node framework's middleware expects:
 * read off the context. A body, a logger and the list of forwarded addresses are not set.
 */
export interface NodeMiddlewareStamp {
  readonly id: string
  readonly hostname: string
  readonly protocol: string
  readonly ip: string | undefined
  readonly query: Readonly<Record<string, string | string[]>>
}

/** What the engine hands `respond`: how to say the answer has left, and how to cut it while it streams. */
export interface SendHooks {
  /** The answer has left: called once, at once for a whole body, when a streamed one ends. Safe to pass detached. */
  readonly sent: () => void
  /** Registers how to cut a streamed answer still being sent, for a forced close. */
  cancelWith(cancel: (reason: Error) => void): void
}

/**
 * How the engine reads one request of a runtime and answers it. `N` is what the runtime hands per request, `P` is
 * `ctx.platform`, `R` is what its entry returns.
 */
export interface ServerPlatform<N, P extends IContextPlatform, R> {
  readonly name: P['name']
  method(native: N): string
  /** Path and query as sent, before the base path is taken off. */
  target(native: N): string
  /** `http` or `https`. */
  protocol(native: N): string
  /** A request header by name, in any case. */
  header(native: N, name: string): string | undefined
  /** Every request header, by lower-case name. */
  headers(native: N): Record<string, string>
  /**
   * `ctx.req.raw`, built once per request. Where the platform builds it, its body is held to `limit` and serves the
   * bytes {@link readBody} read; the fetch platform hands over the runtime's own.
   */
  request(native: N, limit: ByteSize): Request
  /**
   * Whether the request says it carries a body, as its runtime tells: one a request with no `Content-Type` and no
   * body to tell of is read as having none.
   */
  hasBody(native: N): boolean
  /** Whether something other than the route started reading the body. */
  bodyConsumed(native: N): boolean
  /**
   * The whole body, counted to at most `limit` bytes. Called once the engine has checked {@link bodyConsumed} and the
   * declared `Content-Length`. Rejects with `ErrHTTPContentTooLarge` past the limit, `ErrHTTPBadRequest` for a body cut
   * short or other than its `Content-Length`.
   */
  readBody(native: N, limit: ByteSize): Promise<Uint8Array>
  /** Aborts when the client leaves. */
  signal(native: N): AbortSignal
  remoteAddress(native: N): string | undefined
  /** `extra` is what the runtime handed its entry after the request. */
  context(native: N, extra: unknown): P
  /**
   * Sends the answer; a list-valued header goes out as one field line per value. Calls `hooks.sent` once it has left,
   * and, for a stream, registers with `hooks.cancelWith` how to cut it: a reader of its body then fails with the reason.
   */
  respond(native: N, head: ResponseHead, payload: SendPayload, hooks: SendHooks): R
  /**
   * Sends an answer whose body is the Node stream a handler returned, piped as it is, as {@link respond} sends a web
   * stream. Absent on a platform that cannot: the engine then hands `respond` the stream as web bytes.
   */
  respondStream?(native: N, head: ResponseHead, stream: object, hooks: SendHooks): R
  /**
   * Runs a Node `(req, res, next)` middleware on the native request, with `req.url` set to `url` until it calls `next`.
   * `answered` is called when the response closed, by the middleware or the client, without `next`; a `next` after
   * that is ignored. Absent on a runtime with no Node request: a Node middleware is then refused at start-up.
   */
  runNodeMiddleware?(
    native: N,
    fn: NodeMiddleware,
    url: string,
    stamp: NodeMiddlewareStamp,
    next: Next,
    answered: () => void,
  ): void
}

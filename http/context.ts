import type { ConfigSnapshot } from '@caffeinejs/application/config'
import { errMessage } from '@caffeinejs/std/err'

import type { CookieSerializeOptions } from './core/cookie/options.js'
import { ErrCaffeineWebApplication } from './core/error/common.js'
import type { RouteDefinition } from './core/lifecycle/route_definition.js'
import type { RouteOptions } from './core/routing/options.js'
import type { AuthenticationState } from './core/security/auth/authentication_state.js'
import { type Principal } from './core/security/identity.js'
import type { ContextPlatform } from './core/server/platform.js'
import type { IRequest } from './request.js'

/** The server capabilities available to this request. */
export interface ServerContext {
  /** The peer as reported by the adapter, or `undefined` if unknown. An in-process request uses loopback. */
  readonly remoteAddress: string | undefined

  /**
   * Registers work for graceful shutdown without delaying the response. The Node and Bun server adapters and
   * in-process `app.request()` calls provide it for requests admitted before shutdown. An adapter-free
   * `app.fetch()` provides it when `fetchWaitUntil` supplies a host binding for the invocation.
   *
   * The request scope ends with the response. Use application-owned services for work that may outlive it.
   * A forced shutdown stops waiting for the work. Caffeine logs task rejections with the request ID.
   *
   * If the host binding throws, the caller receives that error. If the binding returns a promise that
   * rejects, Caffeine logs the host error with the request ID. Either failure releases this registration
   * from graceful shutdown while Caffeine continues to observe the task. If the binding's promise fulfills
   * first, graceful shutdown still waits for the task.
   *
   * @throws ErrWaitUntilClosed when called after response handoff, request expiry or forced shutdown.
   */
  readonly waitUntil?: (work: Promise<unknown>) => void
}

export class ErrWaitUntilClosed extends ErrCaffeineWebApplication {
  constructor() {
    super(
      errMessage('Cannot register background work: the request is no longer accepting work')
        .solutions('Call ctx.server.waitUntil before the request expires or the response is handed off')
        .reference('@caffeinejs/http', ErrWaitUntilClosed)
        .build(),
      'ERR_WAIT_UNTIL_CLOSED',
    )
    this.name = 'ErrWaitUntilClosed'
  }
}

/**
 * The values a request carries between the middlewares, guards and handler that serve it.
 *
 * `V` names what may be stored, and is declared where the routes are:
 *
 * ```ts
 * type Vars = { tenant: Tenant }
 *
 * const pets = new Router<Vars>('/pets')
 * pets.get('/', ctx => ctx.state.get('tenant'))
 * ```
 *
 * A key reads back `undefined` until something writes it, because whichever middleware writes it may not be
 * installed on the route being served.
 */
export class ContextState<V = Record<never, never>> {
  #vars?: Map<string, unknown>

  get<K extends keyof V & string>(key: K): V[K] | undefined {
    return this.#vars?.get(key) as V[K] | undefined
  }

  set<K extends keyof V & string>(key: K, value: V[K]): void {
    ;(this.#vars ??= new Map()).set(key, value)
  }
}

/** How {@link IContext.header} writes a response header. */
export interface HeaderOptions {
  /**
   * Adds the value to the header instead of replacing what it holds, so the header goes out once per value. For a
   * header several parties contribute to: each authentication scheme a route names adds its own `WWW-Authenticate`
   * challenge.
   */
  append?: boolean
}

/**
 * What a middleware, a guard, an error handler and a route handler see of the request they serve.
 */
export interface IContext<
  V = Record<never, never>,
  C = Record<never, never>,
  TParams = Record<string, string>,
  TQuery = Record<string, string>,
  THeaders = Record<string, string>,
  TBody = unknown,
> {
  get req(): IRequest<TParams, TQuery, THeaders, TBody>

  /** The peer and server capabilities for this exchange. */
  get server(): ServerContext

  /**
   * The runtime's own objects behind this request: the escape hatch for what the context does not cover. Narrow on
   * `name` to reach them: `'node'` holds Node's request and response, `'fetch'` what the runtime handed `fetch`.
   */
  get platform(): ContextPlatform

  /** The values this request carries between the middlewares, guards and handler serving it. */
  get state(): ContextState<V>

  /**
   * The application configuration, as a snapshot: one object for the life of this context, taken the first time
   * it is read. A reload that lands mid-request is not observed once the snapshot has been taken.
   *
   * `C` is declared where the routes are, with `.configType<C>()`. This is a getter, not a function: a package
   * that needs its own settings cannot look them up from here: it binds them and resolves them.
   */
  get config(): ConfigSnapshot<C>

  get statusCode(): number

  /**
   * Aborts when the client leaves before the answer is out, and on a timed route when its handler timeout fires. An
   * answer sent in full never aborts it, so work a handler started may outlive the answer under it.
   */
  get signal(): AbortSignal

  /**
   * The request's principal. The authentication hook is the expected writer; a handler that needs a
   * different identity for a downstream call should pass it explicitly rather than reassign this.
   */
  user: Principal

  /**
   * What each authentication scheme decided for this request, created on first use.
   *
   * The authentication package is the writer. `user` is the outcome and is replaced as a route refines it;
   * this is the record of how each scheme reached it, and is what stops a scheme running twice in one
   * request.
   */
  auth?: AuthenticationState

  /**
   * Whether this request has been answered through this context. A middleware checks it before answering itself.
   *
   * It turns true when `body`, `redirect` or a status shorthand sends, not when the bytes leave — a hook that
   * holds the response open has not unanswered the request. A reply written past the context, on `ctx.platform`,
   * is outside that record.
   */
  get sent(): boolean

  /**
   * The route the request matched, as `onRoute` hooks saw it. `undefined` when no route matched, and for a route
   * Caffeine did not compile itself. What the route set for its plugins is {@link IContext.options}.
   */
  get route(): RouteDefinition | undefined

  /**
   * The options the matched route and its groups set with `config(...)` or `@RouteOptions(...)`:
   * how a hook or a middleware that covers many routes reads one route's setting, `ctx.options.cors`. An empty object
   * when no route matched.
   */
  get options(): Readonly<Partial<RouteOptions>>

  status(code: number): this

  /**
   * Writes a response header, replacing what it holds unless `opts.append` is set. `Set-Cookie` is always added to:
   * one cookie never replaces another.
   */
  header(key: string, value: string, opts?: HeaderOptions): this
  headers(headers: Record<string, string>): this
  hasHeader(key: string): boolean
  /**
   * Reads back a response header written so far, by the route, a hook or the handler. A header holding several
   * values, from {@link IContext.header} with `append` or a list, comes back as one field line, its values joined
   * with `, `.
   *
   * Not for `Set-Cookie`, whose values cannot be joined: cookies set with {@link IContext.cookie} are written only as
   * the response goes out.
   */
  getHeader(key: string): string | undefined
  /**
   * Every response header written so far, by lower-case name: a copy, so writing to it changes nothing. A header
   * holding several values comes back as its list. Cookies set with {@link IContext.cookie} are in it from the first
   * `onSend` hook on.
   */
  getHeaders(): Record<string, string | string[]>
  /** Removes a response header. Once the response is sent, outside an `onSend` hook, it changes nothing. */
  removeHeader(key: string): this

  /**
   * Sets a cookie on the response, over the server's `parseOptions`. Written when the response is sent; a second
   * cookie with the same name, domain and path replaces the first.
   *
   * A cookie a browser would drop is refused here: a broken `__Host-` or `__Secure-` prefix, `SameSite=None` or
   * `Partitioned` without `Secure`, a name and value past 4096 bytes. A signed one is signed when the response goes
   * out.
   *
   * @throws ErrInvalidCookie when a browser would drop or misread the cookie.
   * @throws ErrCookieConfiguration when it is to be signed and there is no secret to sign with.
   * @throws ErrCookieTooLate when the response's headers are already sent.
   * @throws ErrCookiesDisabled when the server has cookies off.
   */
  cookie(name: string, value: string, opts?: CookieSerializeOptions): this

  /**
   * Tells the browser to drop a cookie. `opts` must name the domain and path, and for a partitioned cookie
   * `partitioned`, it was set with: a browser drops only the cookie they match.
   *
   * @throws ErrInvalidCookie when a browser would ignore the deletion, as one of a `__Host-` cookie without `Secure`.
   * @throws ErrCookieTooLate when the response's headers are already sent.
   * @throws ErrCookiesDisabled when the server has cookies off.
   */
  deleteCookie(name: string, opts?: CookieSerializeOptions): this

  /**
   * Sends `body` as the answer, shaped as a value the handler returns is: a `Blob`, bytes, a stream or a `Response` go
   * out as what they hold.
   *
   * It takes a value, never a promise: await it first, or return the promise from the handler, which waits for it.
   * The error helpers below take a value alike, and send it under their own status, a `Response`'s included.
   * @throws ErrConfiguration for a promise, or any thenable, which would go out as `{}`. Nothing is sent, so the
   * handler can still answer.
   */
  body(body?: unknown): this

  notFound(body?: unknown): this

  badRequest(body?: unknown): this

  unprocessableContent(body?: unknown): this

  internalServerError(body: unknown): this

  /**
   * Sends the browser to `url`, with `status` or a `302`.
   *
   * `url` is sent as it is written, except that a leading `~/` is resolved against the application's base path:
   * `~/done` is `/api/done` under `.basePath('/api')`, and `/done` with none. A URL the application builds for
   * itself is written that way, since `/done` is sent as `/done` and leaves the base behind.
   */
  redirect(url: string, status?: number): this
}

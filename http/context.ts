import type { ConfigSnapshot } from '@caffeinejs/std/config'
import type { AnySchema, InferSchema } from '@caffeinejs/std/schema'

import type { AdapterTypes, AnyAdapterTypes } from './adapter.js'
import type { CookieSecret, CookieUnsignResult } from './cookie/signer.js'
import type { RouteValidationSchema } from './routing/spec.js'
import type { AuthenticationState } from './security/auth/authentication_state.js'
import { type Principal } from './security/index.js'

export type UnsignedCookie = string | false | undefined

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

export interface Req<
  RAW = unknown,
  TParams = Record<string, string>,
  TQuery = Record<string, string>,
  THeaders = Record<string, string>,
  TAsync extends boolean = false,
  TBody = unknown,
> {
  get raw(): RAW

  /** The request's path and query as the application sees it: without the {@link basePath} the server took off. */
  get url(): string

  /**
   * What the server took off the front of the request's path before routing it — the application's
   * `.basePath(...)` — or `''` when there is none, or when the request came without it.
   *
   * A URL the browser is sent to puts it back — `ctx.redirect('~/signed-out')` does it for a redirect, and
   * `ctx.req.basePath + '/signed-out'` anywhere else, such as a link in a page.
   */
  get basePath(): string

  get method(): string

  /**
   * The parsed request body, as the adapter's content-type parser produced it, typed by the route's `body`
   * schema when it declares one.
   *
   * A handler that takes its arguments through pickers reaches the body with `$p.body()` instead; this is the
   * accessor for one that receives only the context.
   */
  body(): TBody

  query(): TQuery
  query(key: string): string | undefined

  queries(key: string): string[] | undefined

  header(): THeaders
  header(key: string): string | undefined

  hasHeader(key: string): boolean

  param(): TParams
  param(key: string): string | undefined

  /**
   * The cookies the request carries, parsed on first read. Of two sharing a name, the first wins: a browser sends
   * the more specific one first.
   *
   * @throws ErrCookiesDisabled when the server has cookies off.
   */
  cookie(): Record<string, string>
  cookie(name: string): string | undefined

  /**
   * Every cookie the request carries, verified with the server's signer: the value, or `false` for one that does not
   * verify. A cookie signed with a secret of its own reads as `false` here.
   */
  signedCookie(): TAsync extends true ? Promise<Record<string, UnsignedCookie>> : Record<string, UnsignedCookie>
  /**
   * The value a signed cookie carries, `false` when it does not verify, or `undefined` when the request did not send
   * it.
   *
   * `secret` verifies with that secret instead of the server's signer, the one `ctx.cookie(name, value, { secret })`
   * signed with. An array rotates: any of its entries verifies.
   *
   * @throws ErrCookieConfiguration when there is no secret to verify with.
   */
  signedCookie(name: string, secret?: CookieSecret): TAsync extends true ? Promise<UnsignedCookie> : UnsignedCookie

  /**
   * Verifies a signed value, a cookie's as the request carries it, and says what the verifying found: `{ valid, renew,
   * value }`, or `{ valid: false, renew: false, value: null }` for one that does not verify.
   *
   * `renew` says a secret other than the first verified it. Set the cookie again, with the options it was set with,
   * and it goes out signed with the first: an older secret can then be retired while its cookies are still in use.
   * `secret` verifies with that secret instead of the server's signer, as in {@link signedCookie}.
   *
   * @example
   * ```ts
   * const result = await ctx.req.unsignCookie(ctx.req.cookie('session') ?? '')
   *
   * if (result.valid && result.renew) {
   *   ctx.cookie('session', result.value, { path: '/', signed: true })
   * }
   * ```
   *
   * @throws ErrCookieConfiguration when there is no secret to verify with.
   * @throws ErrCookiesDisabled when the server has cookies off.
   */
  unsignCookie(
    value: string,
    secret?: CookieSecret,
  ): TAsync extends true ? Promise<CookieUnsignResult> : CookieUnsignResult
}

/**
 * What a middleware, a guard, an error handler and a route handler see of the request they serve.
 *
 * `T` is the serving adapter's {@link AdapterTypes}. Left out, it is any registered adapter's, which is what a
 * middleware or a `Responder` written without knowing its adapter gets.
 */
export interface Context<
  V = Record<never, never>,
  C = Record<never, never>,
  T extends AdapterTypes = AnyAdapterTypes,
  TParams = Record<string, string>,
  TQuery = Record<string, string>,
  THeaders = Record<string, string>,
  TBody = unknown,
> {
  get req(): Req<T['raw'], TParams, TQuery, THeaders, T['asyncCookies'], TBody>

  /**
   * The server library's own objects behind this request: the escape hatch for what the context does not
   * cover. What it holds belongs to the adapter. `name` says which adapter, and is what code written against
   * one narrows on.
   */
  get platform(): T['platform']

  /** The values this request carries between the middlewares, guards and handler serving it. */
  get state(): ContextState<V>

  /**
   * The application configuration, as a snapshot: one object for the life of this context, taken the first time
   * it is read. A reload that lands mid-request is not observed once the snapshot has been taken.
   *
   * `C` is declared where the routes are, with `.configType<C>()`. This is a getter, not a function: a package
   * that needs its own settings cannot look them up from here. It binds them and resolves them, or reads a
   * decoration off the Fastify instance as `@caffeinejs/html` does.
   */
  get config(): ConfigSnapshot<C>

  get statusCode(): number

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
   * Whether this request has been answered: one of this context's own answers has sent, or the reply went out
   * some other way. A middleware checks it before answering itself.
   *
   * It turns true when `body`, `redirect` or a status shorthand sends, not when the bytes leave — a hook that
   * holds the response open has not unanswered the request. Code reaching past the context to the server's own
   * reply is outside that record, and is seen here only once the response has actually ended.
   */
  get sent(): boolean

  /**
   * What the route declared, as the adapter recorded it. The shape belongs to the adapter — the Fastify one
   * returns its `FastifyContextConfig` — so a consumer narrows it to the adapter it is written against.
   */
  get routeConfig(): unknown

  status(code: number): this

  header(key: string, value: string): this
  /**
   * Adds a value to a response header instead of replacing what it holds, so the header goes out once per value.
   * For a header several parties contribute to: each authentication scheme a route names adds its own
   * `WWW-Authenticate` challenge.
   */
  appendHeader(key: string, value: string): this
  headers(headers: Record<string, string>): this
  hasHeader(key: string): boolean

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
  cookie(name: string, value: string, opts?: T['cookieOptions']): this

  /**
   * Tells the browser to drop a cookie. `opts` must name the domain and path, and for a partitioned cookie
   * `partitioned`, it was set with: a browser drops only the cookie they match.
   *
   * @throws ErrInvalidCookie when a browser would ignore the deletion, as one of a `__Host-` cookie without `Secure`.
   * @throws ErrCookieTooLate when the response's headers are already sent.
   * @throws ErrCookiesDisabled when the server has cookies off.
   */
  deleteCookie(name: string, opts?: T['cookieOptions']): this

  body(body?: unknown): this

  notFound(body?: unknown): this

  badRequest(body?: unknown): this

  unprocessableEntity(body?: unknown): this

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

/**
 * Derives the type of a request slot from the schema declared for it, falling back to `Fallback` when the route
 * declares nothing for that slot.
 *
 * ```ts
 * const PetRoute = { params: $t.Object({ id: $t.Integer() }) }
 *
 * // ctx.req.param() is { id: number }
 * handler(ctx: FastifyContext<Vars, typeof PetRoute>) { ... }
 * ```
 *
 * Inference reads the *authored* schema, so it reflects what the author wrote — not the per-slot strictness
 * the route compilation adds on top.
 */
export type InferSlot<S, Slot extends keyof RouteValidationSchema, Fallback> =
  S extends Record<Slot, infer Schema extends AnySchema> ? InferSchema<Schema> : Fallback

export type InferParams<S> = InferSlot<S, 'params', Record<string, string>>
export type InferQuery<S> = InferSlot<S, 'querystring', Record<string, string>>
export type InferHeaders<S> = InferSlot<S, 'headers', Record<string, string>>
export type InferBody<S> = InferSlot<S, 'body', unknown>

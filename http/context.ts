import type { AnySchema, InferSchema } from '@caffeinejs/std'
import type { ConfigSnapshot } from '@caffeinejs/std/config'

import type { AdapterTypes, AnyAdapterTypes } from './adapter_types.js'
import type { RouteValidationSchema } from './route.js'
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
  get url(): string
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

  cookie(): Record<string, string>
  cookie(name: string): string | undefined

  signedCookie(): TAsync extends true ? Promise<Record<string, UnsignedCookie>> : Record<string, UnsignedCookie>
  signedCookie(name: string): TAsync extends true ? Promise<UnsignedCookie> : UnsignedCookie
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

  /** Whether the response has already been written. A middleware checks it before answering itself. */
  get sent(): boolean

  /**
   * What the route declared, as the adapter recorded it. The shape belongs to the adapter — the Fastify one
   * returns its `FastifyContextConfig` — so a consumer narrows it to the adapter it is written against.
   */
  get routeConfig(): unknown

  status(code: number): this

  header(key: string, value: string): this
  headers(headers: Record<string, string>): this
  hasHeader(key: string): boolean

  cookie(name: string, value: string, opts?: T['cookieOptions']): this

  deleteCookie(name: string, opts?: T['cookieOptions']): this

  body(body?: unknown): this

  notFound(body?: unknown): this

  badRequest(body?: unknown): this

  unprocessableEntity(body?: unknown): this

  internalServerError(body: unknown): this

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

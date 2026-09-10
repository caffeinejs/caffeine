import { IncomingMessage } from 'http'

import type { AnySchema, InferSchema } from '@caffeinejs/std'
import type { ConfigHandle, Configuration } from '@caffeinejs/std/config'
import { CookieSerializeOptions } from '@fastify/cookie'
import {
  FastifyRequest,
  RawServerDefault,
  RawRequestDefaultExpression,
  FastifyReply,
  type FastifyContextConfig,
} from 'fastify'

import { statusErrorBody } from './error/http.js'
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
 * The Fastify objects behind a context: the escape hatch for platform-specific consumers, such as view rendering
 * reaching `reply.view` or `@caffeinejs/multipart` reading `request.parts()`.
 */
export interface Fst<REPLY extends FastifyReply = FastifyReply> {
  get request(): FastifyRequest
  get reply(): REPLY
}

export interface Context<
  V = Record<never, never>,
  C = Record<never, never>,
  REQ = unknown,
  CO = unknown,
  TAsync extends boolean = false,
  TParams = Record<string, string>,
  TQuery = Record<string, string>,
  THeaders = Record<string, string>,
  TBody = unknown,
> {
  get req(): Req<REQ, TParams, TQuery, THeaders, TAsync, TBody>

  /** The values this request carries between the middlewares, guards and handler serving it. */
  get state(): ContextState<V>

  /**
   * The application configuration, as a snapshot: one object for the life of this context, taken the first time
   * it is read. A refresh that lands mid-request is not observed once the snapshot has been taken.
   *
   * `C` is declared where the routes are, with `.configType<C>()`. Calling it reads a feature's own
   * configuration instead — `ctx.config(kHTMLConfig)` — which is how a package with no knowledge of `C` reaches
   * the settings it registered.
   */
  get config(): ConfigHandle<C>

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

  cookie(name: string, value: string, opts?: CO): this

  deleteCookie(name: string, opts?: CO): this

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

export class FastifyContext<
  V = Record<never, never>,
  SCHEMA extends RouteValidationSchema = RouteValidationSchema,
  C = Record<never, never>,
  REPLY extends FastifyReply = FastifyReply,
> implements Context<
  V,
  C,
  RawRequestDefaultExpression<RawServerDefault>,
  CookieSerializeOptions,
  false,
  InferParams<SCHEMA>,
  InferQuery<SCHEMA>,
  InferHeaders<SCHEMA>,
  InferBody<SCHEMA>
> {
  /** @see {@link Context.auth} */
  auth?: AuthenticationState

  #req!: FastifyContextRequest<SCHEMA>
  #fst!: Fst<REPLY>
  #state!: ContextState<V>
  #config?: ConfigHandle<C>
  #fastifyRequest: FastifyRequest
  #reply: REPLY
  #configuration: Configuration<unknown>

  constructor(request: FastifyRequest, reply: REPLY, configuration: Configuration<unknown>) {
    this.#reply = reply
    this.#fastifyRequest = request
    this.#configuration = configuration
  }

  get req(): FastifyContextRequest<SCHEMA> {
    return (this.#req ??= new FastifyContextRequest<SCHEMA>(this.#fastifyRequest))
  }

  /** The underlying Fastify request and reply. The escape hatch for platform-specific consumers. */
  get fst(): Fst<REPLY> {
    return (this.#fst ??= { request: this.#fastifyRequest, reply: this.#reply })
  }

  get state(): ContextState<V> {
    return (this.#state ??= new ContextState<V>())
  }

  /**
   * The application configuration, as a snapshot taken the first time this reads.
   *
   * The tree is replaced wholesale by a refresh rather than mutated, so the object handed back keeps the values
   * it had when it was taken — a refresh landing later in the same request is not observed here.
   */
  get config(): ConfigHandle<C> {
    return (this.#config ??= this.#configuration.snapshotHandle as ConfigHandle<C>)
  }

  get user(): Principal {
    return this.#fastifyRequest.user
  }

  set user(user: Principal) {
    this.#fastifyRequest.user = user
  }

  get sent(): boolean {
    return this.#reply.sent
  }

  /**
   * The route's Fastify config — where the adapter records what a route declared. The authentication
   * middleware reads its per-route options from here, which is what keeps it off the raw request.
   */
  get routeConfig(): FastifyContextConfig {
    return this.#fastifyRequest.routeOptions.config as FastifyContextConfig
  }

  get statusCode(): number {
    return this.#reply.statusCode
  }

  get signal(): AbortSignal {
    return this.#fastifyRequest.signal
  }

  status(code: number): this {
    this.#reply.code(code)
    return this
  }

  header(key: string, value: string): this {
    this.#reply.header(key, value)
    return this
  }

  headers(headers: Record<string, string>): this {
    this.#reply.headers(headers)
    return this
  }

  hasHeader(key: string): boolean {
    return this.#reply.hasHeader(key)
  }

  removeHeader(key: string): this {
    this.#reply.removeHeader(key)
    return this
  }

  body(body?: unknown): this {
    this.#reply.send(body)
    return this
  }

  badRequest(body?: unknown): this {
    return this.#fail(400, 'ERR_HTTP_BAD_REQUEST', body)
  }

  notFound(body?: unknown): this {
    return this.#fail(404, 'ERR_HTTP_NOT_FOUND', body)
  }

  unprocessableEntity(body?: unknown): this {
    return this.#fail(422, 'ERR_HTTP_UNPROCESSABLE_ENTITY', body)
  }

  internalServerError(body?: unknown): this {
    return this.#fail(500, 'ERR_HTTP_INTERNAL_SERVER_ERROR', body)
  }

  redirect(url: string, status?: number): this {
    this.#reply.redirect(url, status)
    return this
  }

  cookie(name: string, value: string, opts?: CookieSerializeOptions): this {
    this.#reply.setCookie(name, value, opts)
    return this
  }

  deleteCookie(name: string, opts?: CookieSerializeOptions): this {
    this.#reply.clearCookie(name, opts)
    return this
  }

  /**
   * Sends an error status, defaulting the body to the same envelope a thrown `ErrHTTP` renders to.
   *
   * Without the default these shorthands answer with an empty body, which leaves an application emitting one
   * error shape from `@Catch` and a different one from `ctx.notFound()`.
   */
  #fail(statusCode: number, code: string, body?: unknown): this {
    this.#reply.code(statusCode).send(body ?? statusErrorBody(statusCode, code))
    return this
  }
}

export class FastifyContextRequest<SCHEMA extends RouteValidationSchema = RouteValidationSchema> implements Req<
  RawRequestDefaultExpression<RawServerDefault>,
  InferParams<SCHEMA>,
  InferQuery<SCHEMA>,
  InferHeaders<SCHEMA>,
  false,
  InferBody<SCHEMA>
> {
  constructor(private readonly request: FastifyRequest) {}

  get raw(): IncomingMessage {
    return this.request.raw
  }

  get url(): string {
    return this.request.url
  }

  get method(): string {
    return this.request.method
  }

  body(): InferBody<SCHEMA> {
    return this.request.body as InferBody<SCHEMA>
  }

  header(): InferHeaders<SCHEMA>
  header(key: string): string | undefined
  header(key?: string): InferHeaders<SCHEMA> | string | undefined {
    if (key === undefined) {
      return this.request.headers as InferHeaders<SCHEMA>
    }
    return this.request.headers[key] as string | undefined
  }

  hasHeader(key: string): boolean {
    return this.request.headers[key] !== undefined
  }

  param(): InferParams<SCHEMA>
  param(key: string): string | undefined
  param(key?: string): InferParams<SCHEMA> | string | undefined {
    if (key === undefined) {
      return this.request.params as InferParams<SCHEMA>
    }
    return (this.request.params as Record<string, string>)[key]
  }

  query(): InferQuery<SCHEMA>
  query(key: string): string | undefined
  query(key?: string): InferQuery<SCHEMA> | string | undefined {
    if (key === undefined) {
      return this.request.query as InferQuery<SCHEMA>
    }
    return (this.request.query as Record<string, string>)[key]
  }

  queries(key: string): string[] | undefined {
    const val = (this.request.query as Record<string, string | string[] | undefined>)[key]
    if (Array.isArray(val)) {
      return val
    }

    return val !== undefined ? [val] : undefined
  }

  cookie(): Record<string, string>
  cookie(name: string): string | undefined
  cookie(name?: string): Record<string, string> | string | undefined {
    if (typeof this.request.cookies === 'undefined') {
      throw new Error('Cannot read cookies: @fastify/cookie plugin is not registered on this Fastify instance')
    }

    if (name === undefined) {
      return this.request.cookies as Record<string, string>
    }

    return this.request.cookies[name] as string | undefined
  }

  signedCookie(): Record<string, UnsignedCookie>
  signedCookie(name: string): UnsignedCookie
  signedCookie(name?: string): Record<string, UnsignedCookie> | UnsignedCookie {
    if (typeof this.request.cookies === 'undefined') {
      throw new Error('Cannot read cookies: @fastify/cookie plugin is not registered on this Fastify instance')
    }

    if (typeof name === 'string') {
      const cookie = this.request.cookies[name]
      if (cookie === undefined) {
        return undefined
      }

      const result = this.request.unsignCookie(cookie)

      return result.valid && result.value !== null ? result.value : false
    }

    const cookies = this.request.cookies as Record<string, string>
    const ret: Record<string, UnsignedCookie> = {}
    for (const [name, value] of Object.entries(cookies)) {
      ret[name] = this.#unsignCookie(value)
    }

    return ret
  }

  #unsignCookie(cookie: string): string | false {
    const result = this.request.unsignCookie(cookie)
    return result.valid && result.value !== null ? result.value : false
  }
}

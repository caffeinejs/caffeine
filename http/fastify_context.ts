import type { IncomingMessage } from 'node:http'

import type { ConfigSnapshot, ConfigStore } from '@caffeinejs/std/config'
import type { CookieSerializeOptions } from '@fastify/cookie'
import type { FastifyContextConfig, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import {
  ContextState,
  type Context,
  type InferBody,
  type InferHeaders,
  type InferParams,
  type InferQuery,
  type Req,
  type UnsignedCookie,
} from './context.js'
import { statusErrorBody } from './error/http.js'
import type { FastifyPlatform, FastifyTypes } from './fastify_types.js'
import type { RouteValidationSchema } from './route.js'
import type { AuthenticationState } from './security/auth/authentication_state.js'
import { type Principal } from './security/index.js'

/** The {@link Context} the Fastify adapter builds for every request, over Fastify's own request and reply. */
export class FastifyContext<
  V = Record<never, never>,
  SCHEMA extends RouteValidationSchema = RouteValidationSchema,
  C = Record<never, never>,
  REPLY extends FastifyReply = FastifyReply,
> implements Context<
  V,
  C,
  FastifyTypes<FastifyInstance, FastifyRequest, REPLY>,
  InferParams<SCHEMA>,
  InferQuery<SCHEMA>,
  InferHeaders<SCHEMA>,
  InferBody<SCHEMA>
> {
  /** @see {@link Context.auth} */
  auth?: AuthenticationState

  #req!: FastifyContextRequest<SCHEMA>
  #platform!: FastifyPlatform<REPLY>
  #state!: ContextState<V>
  #config?: ConfigSnapshot<C>
  #fastifyRequest: FastifyRequest
  #reply: REPLY
  #store: ConfigStore<unknown>

  constructor(request: FastifyRequest, reply: REPLY, store: ConfigStore<unknown>) {
    this.#reply = reply
    this.#fastifyRequest = request
    this.#store = store
  }

  get req(): FastifyContextRequest<SCHEMA> {
    return (this.#req ??= new FastifyContextRequest<SCHEMA>(this.#fastifyRequest))
  }

  /** The Fastify request and reply behind this context. See {@link Context.platform}. */
  get platform(): FastifyPlatform<REPLY> {
    return (this.#platform ??= { name: 'fastify', request: this.#fastifyRequest, reply: this.#reply })
  }

  get state(): ContextState<V> {
    return (this.#state ??= new ContextState<V>())
  }

  /**
   * The application configuration, as the snapshot current the first time this reads.
   *
   * A reload replaces the snapshot rather than mutating it, so the object handed back keeps the values it had when
   * it was taken — a reload landing later in the same request is not observed here.
   */
  get config(): ConfigSnapshot<C> {
    return (this.#config ??= this.#store.current as ConfigSnapshot<C>)
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

  appendHeader(key: string, value: string): this {
    const current = this.#reply.getHeader(key)

    if (current === undefined) {
      this.#reply.header(key, value)
    } else {
      this.#reply.header(key, [...(Array.isArray(current) ? current : [String(current)]), value])
    }

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
  IncomingMessage,
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
    this.#assertCookiesParsed()

    if (name === undefined) {
      return this.request.cookies as Record<string, string>
    }

    return this.request.cookies[name] as string | undefined
  }

  signedCookie(): Record<string, UnsignedCookie>
  signedCookie(name: string): UnsignedCookie
  signedCookie(name?: string): Record<string, UnsignedCookie> | UnsignedCookie {
    this.#assertCookiesParsed()

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

  /**
   * `@fastify/cookie` decorates the request with `cookies: null` and fills it in from a hook of its own, so `null`
   * means the plugin is there and has not run yet for this request, which is a different mistake from its absence.
   */
  #assertCookiesParsed(): void {
    if (this.request.cookies === undefined) {
      throw new Error('Cannot read cookies: @fastify/cookie plugin is not registered on this Fastify instance')
    }

    if (this.request.cookies === null) {
      throw new Error(
        'Cannot read cookies: @fastify/cookie has not parsed them yet for this request: register it before whatever ' +
          'reads cookies, such as .authentication(...), and leave its "hook" option on "onRequest"',
      )
    }
  }

  #unsignCookie(cookie: string): string | false {
    const result = this.request.unsignCookie(cookie)
    return result.valid && result.value !== null ? result.value : false
  }
}

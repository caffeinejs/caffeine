import type { IncomingMessage } from 'node:http'

import type { ConfigSnapshot, ConfigStore } from '@caffeinejs/std/config'
import type { FastifyContextConfig, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { kRawBasePath, resolveAppURL, type BasePathCarrier } from './base_path.js'
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
import type { CookieSerializeOptions } from './cookie/options.js'
import { reopenCookieFlush, serverCookies } from './cookie/plugin.js'
import type { CookieSecret, CookieUnsignResult } from './cookie/signer.js'
import { statusErrorBody } from './error/http.js'
import type { FastifyPlatform, FastifyTypes } from './fastify_adapter.js'
import { protocolOf } from './protocol.js'
import type { RouteValidationSchema } from './routing/spec.js'
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

  // Set once one of this context's own answers has called `send`, which is earlier than Fastify's `reply.sent`:
  // that one is `raw.writableEnded`, and an `onSend` hook that awaits — a compressor, a cache storing the entry
  // — holds the send open with it still false. Asked in that window whether the request has been answered, the
  // honest answer is yes, or a second send starts over the first.
  #answered = false

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

  /** @see {@link Context.sent} */
  get sent(): boolean {
    return this.#answered || this.#reply.sent
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
      // Removed first: Fastify adds a `set-cookie` value to the ones it holds, which would send these twice.
      this.#reply.removeHeader(key)
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
    // Before the send, so a send that throws still leaves the context answered.
    this.#answered = true
    // A send after one whose cookies failed to write — an error handler's — has a pass of its own.
    reopenCookieFlush(this.#reply)
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
    this.#answered = true
    reopenCookieFlush(this.#reply)
    this.#reply.redirect(resolveAppURL(url, this.req.basePath), status)
    return this
  }

  cookie(name: string, value: string, opts?: CookieSerializeOptions): this {
    serverCookies(this.#fastifyRequest, 'set cookies').set(this.#fastifyRequest, this.#reply, name, value, opts)
    return this
  }

  deleteCookie(name: string, opts?: CookieSerializeOptions): this {
    serverCookies(this.#fastifyRequest, 'delete cookies').delete(this.#fastifyRequest, this.#reply, name, opts)
    return this
  }

  /**
   * Sends an error status, defaulting the body to the same envelope a thrown `ErrHTTP` renders to.
   *
   * Without the default these shorthands answer with an empty body, which leaves an application emitting one
   * error shape from `@Catch` and a different one from `ctx.notFound()`.
   */
  #fail(statusCode: number, code: string, body?: unknown): this {
    return this.status(statusCode).body(body ?? statusErrorBody(statusCode, code))
  }
}

export class FastifyContextRequest<SCHEMA extends RouteValidationSchema = RouteValidationSchema> implements Req<
  IncomingMessage,
  InferParams<SCHEMA>,
  InferQuery<SCHEMA>,
  InferHeaders<SCHEMA>,
  true,
  InferBody<SCHEMA>
> {
  #cookies?: Record<string, string>

  constructor(private readonly request: FastifyRequest) {}

  get raw(): IncomingMessage {
    return this.request.raw
  }

  get url(): string {
    return this.request.url
  }

  get basePath(): string {
    return (this.request.raw as IncomingMessage & BasePathCarrier)[kRawBasePath] ?? ''
  }

  get method(): string {
    return this.request.method
  }

  get host(): string {
    return this.request.host
  }

  get protocol(): string {
    return protocolOf(this.request)
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
    const cookies = this.#parsedCookies()

    return name === undefined ? cookies : cookies[name]
  }

  signedCookie(): Promise<Record<string, UnsignedCookie>>
  signedCookie(name: string, secret?: CookieSecret): Promise<UnsignedCookie>
  async signedCookie(name?: string, secret?: CookieSecret): Promise<Record<string, UnsignedCookie> | UnsignedCookie> {
    const server = serverCookies(this.request, 'read cookies')
    const cookies = this.#parsedCookies()

    if (name !== undefined) {
      const raw = cookies[name]

      return raw === undefined ? undefined : server.verify(raw, secret)
    }

    const names = Object.keys(cookies)
    const values = await Promise.all(names.map(cookie => server.verify(cookies[cookie]!, undefined)))

    return Object.fromEntries(names.map((cookie, i) => [cookie, values[i]]))
  }

  async unsignCookie(value: string, secret?: CookieSecret): Promise<CookieUnsignResult> {
    return serverCookies(this.request, 'unsign a cookie').unsign(value, secret)
  }

  /** Parsed once per request, on first read. */
  #parsedCookies(): Record<string, string> {
    return (this.#cookies ??= serverCookies(this.request, 'read cookies').parse(this.request))
  }
}

import { IncomingMessage } from 'http'
import type { AnySchema, InferSchema } from '@caffeinejs/std'
import { FastifyRequest, RawServerDefault, RawRequestDefaultExpression, FastifyReply } from 'fastify'
import { CookieSerializeOptions } from '@fastify/cookie'
import type { RouteValidationSchema } from './route.js'
import { type Principal } from './security/index.js'

export type UnsignedCookie = string | false | undefined

export interface Req<
  RAW = unknown,
  TParams = Record<string, string>,
  TQuery = Record<string, string>,
  THeaders = Record<string, string>,
  TAsync extends boolean = false,
> {
  get raw(): RAW
  get url(): string
  get method(): string

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

export interface Context<
  REQ = unknown,
  CO = unknown,
  TAsync extends boolean = false,
  TParams = Record<string, string>,
  TQuery = Record<string, string>,
  THeaders = Record<string, string>,
> {
  get req(): Req<REQ, TParams, TQuery, THeaders, TAsync>

  get statusCode(): number

  get signal(): AbortSignal

  get user(): Principal

  status(code: number): this

  header(key: string, value: string): this
  headers(headers: Record<string, string>): this

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
 * handler(ctx: FastifyContext<typeof PetRoute>) { ... }
 * ```
 *
 * Inference reads the *authored* schema, so it reflects what the author wrote — not the per-slot strictness
 * the route compilation adds on top.
 */
export type InferSlot<S, Slot extends keyof RouteValidationSchema, Fallback>
  = S extends Record<Slot, infer Schema extends AnySchema> ? InferSchema<Schema> : Fallback

export type InferParams<S> = InferSlot<S, 'params', Record<string, string>>
export type InferQuery<S> = InferSlot<S, 'querystring', Record<string, string>>
export type InferHeaders<S> = InferSlot<S, 'headers', Record<string, string>>
export type InferBody<S> = InferSlot<S, 'body', unknown>

export class FastifyContext<
  SCHEMA extends RouteValidationSchema = RouteValidationSchema,
  REPLY extends FastifyReply = FastifyReply,
> implements Context<
  RawRequestDefaultExpression<RawServerDefault>,
  CookieSerializeOptions,
  false,
  InferParams<SCHEMA>,
  InferQuery<SCHEMA>,
  InferHeaders<SCHEMA>
> {
  #req!: FastifyContextRequest<SCHEMA>
  #fastifyRequest: FastifyRequest
  #reply: REPLY

  constructor(
    request: FastifyRequest,
    reply: REPLY,
  ) {
    this.#reply = reply
    this.#fastifyRequest = request
  }

  get req(): FastifyContextRequest<SCHEMA> {
    return this.#req ??= new FastifyContextRequest<SCHEMA>(this.#fastifyRequest)
  }

  /** The underlying Fastify reply. The escape hatch for platform-specific consumers (e.g. view rendering). */
  get reply(): REPLY {
    return this.#reply
  }

  get user(): Principal {
    return this.#fastifyRequest.user
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

  removeHeader(key: string): this {
    this.#reply.removeHeader(key)
    return this
  }

  body(body?: unknown): this {
    this.#reply.send(body)
    return this
  }

  badRequest(body?: unknown): this {
    this.#reply.code(400).send(body)
    return this
  }

  notFound(body?: unknown): this {
    this.#reply.code(404).send(body)
    return this
  }

  unprocessableEntity(body?: unknown): this {
    this.#reply.code(422).send(body)
    return this
  }

  internalServerError(body?: unknown): this {
    this.#reply.code(500).send(body)
    return this
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
}

export class FastifyContextRequest<SCHEMA extends RouteValidationSchema = RouteValidationSchema> implements Req<
  RawRequestDefaultExpression<RawServerDefault>, InferParams<SCHEMA>, InferQuery<SCHEMA>, InferHeaders<SCHEMA>
> {
  constructor(private readonly request: FastifyRequest) { }

  get raw(): IncomingMessage {
    return this.request.raw
  }

  get url(): string {
    return this.request.url
  }

  get method(): string {
    return this.request.method
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

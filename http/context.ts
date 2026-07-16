import { FastifyRequest, RawServerDefault, RawRequestDefaultExpression, FastifyReply } from 'fastify'
import { CookieSerializeOptions } from '@fastify/cookie'
import type { RouteValidationSchema } from './route.js'
import { type Principal } from './security/index.js'
import { FastifyContextRequest } from './FastifyContextRequest.js'

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

export interface Context<REQ = unknown, CO = unknown, TAsync extends boolean = false> {
  get req(): Req<REQ, Record<string, string>, Record<string, string>, Record<string, string>, TAsync>

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

export interface FastifyRouteSchema<
  _TParams = Record<string, string>,
  _TQuery = Record<string, string>,
  _THeaders = Record<string, string>,
  _TBody = unknown,
> extends RouteValidationSchema {}

export type InferParams<S> = S extends FastifyRouteSchema<infer P, any, any, any> ? P : Record<string, string>
export type InferQuery<S> = S extends FastifyRouteSchema<any, infer Q, any, any> ? Q : Record<string, string>
export type InferHeaders<S> = S extends FastifyRouteSchema<any, any, infer H, any> ? H : Record<string, string>

declare module 'fastify' {
  interface FastifyRequest {
    caffeineContext: FastifyContext
  }
}

export class FastifyContext<
  SCHEMA extends FastifyRouteSchema = FastifyRouteSchema,
  REPLY extends FastifyReply = FastifyReply,
> implements Context<
  RawRequestDefaultExpression<RawServerDefault>,
  CookieSerializeOptions
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

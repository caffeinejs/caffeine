import { IncomingMessage } from 'http'
import { Context, Req, RouteValidationSchema, UnsignedCookie } from '@caffeinejs/http'
import { FastifyRequest, RawServerDefault, RawRequestDefaultExpression, FastifyReply } from 'fastify'
import { CookieSerializeOptions } from '@fastify/cookie'

export interface FastifyRouteSchema<
  _TParams = Record<string, string>,
  _TQuery = Record<string, string>,
  _THeaders = Record<string, string>,
  _TBody = unknown,
> extends RouteValidationSchema {}

type InferParams<S> = S extends FastifyRouteSchema<infer P, any, any, any> ? P : Record<string, string>
type InferQuery<S> = S extends FastifyRouteSchema<any, infer Q, any, any> ? Q : Record<string, string>
type InferHeaders<S> = S extends FastifyRouteSchema<any, any, infer H, any> ? H : Record<string, string>

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
  #req: FastifyContextRequest<SCHEMA>
  #reply: REPLY
  #store: Map<unknown, unknown> | undefined

  constructor(
    request: FastifyRequest,
    reply: REPLY,
  ) {
    this.#req = new FastifyContextRequest<SCHEMA>(request)
    this.#reply = reply
  }

  get req(): FastifyContextRequest<SCHEMA> {
    return this.#req
  }

  get<T>(key: unknown): T | undefined {
    return this.#store?.get(key) as T | undefined
  }

  set(key: unknown, value: unknown): this {
    if (!this.#store) {
      this.#store = new Map()
    }

    this.#store.set(key, value)

    return this
  }

  status(code: number): this {
    this.#reply.code(code)
    return this
  }

  header(key: string, value: string): this {
    this.#reply.header(key, value)
    return this
  }

  body(body?: unknown): this {
    this.#reply.send(body)
    return this
  }

  notFound(): this {
    this.#reply.code(404).send()
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

export class FastifyContextRequest<SCHEMA extends FastifyRouteSchema = FastifyRouteSchema> implements Req<
  RawRequestDefaultExpression<RawServerDefault>,
  InferParams<SCHEMA>,
  InferQuery<SCHEMA>,
  InferHeaders<SCHEMA>
> {
  constructor(private readonly request: FastifyRequest) {}

  get raw(): IncomingMessage {
    return this.request.raw
  }

  get path(): string {
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

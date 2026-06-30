import { IncomingMessage } from 'node:http'
import { Context, Req, RouteValidationSchema, UnsignedCookie } from '@caffeinejs/http'
import { Context as HonoCtx } from 'hono'
import {
  getCookie,
  setCookie,
  deleteCookie,
  getSignedCookie,
  setSignedCookie,
} from 'hono/cookie'
import type { CookieOptions } from 'hono/utils/cookie'
import type { RedirectStatusCode, StatusCode } from 'hono/utils/http-status'

export const PENDING_RESPONSE = Symbol('pendingResponse')

export interface HonoRouteSchema<
  _TParams = Record<string, string>,
  _TQuery = Record<string, string>,
  _THeaders = Record<string, string>,
  _TBody = unknown,
> extends RouteValidationSchema {}

type InferParams<S> = S extends HonoRouteSchema<infer P, any, any, any> ? P : Record<string, string>
type InferQuery<S> = S extends HonoRouteSchema<any, infer Q, any, any> ? Q : Record<string, string>
type InferHeaders<S> = S extends HonoRouteSchema<any, any, infer H, any> ? H : Record<string, string>

type HonoCtxWithPending = HonoCtx & { [PENDING_RESPONSE]?: Response }

export class HonoContext<SCHEMA extends HonoRouteSchema = HonoRouteSchema> implements Context<
  IncomingMessage,
  CookieOptions,
  true
> {
  constructor(
    private readonly c: HonoCtx,
    private readonly cookieSecret?: string | string[],
  ) {}

  get req(): HonoContextRequest<SCHEMA> {
    return new HonoContextRequest<SCHEMA>(this.c, this.cookieSecret)
  }

  status(code: number): this {
    this.c.status(code as StatusCode)
    return this
  }

  header(key: string, value: string): this {
    this.c.header(key, value)
    return this
  }

  cookie(name: string, value: string, opts?: CookieOptions): this {
    setCookie(this.c, name, value, opts)
    return this
  }

  deleteCookie(name: string, opts?: CookieOptions): this {
    deleteCookie(this.c, name, opts)
    return this
  }

  body(body: unknown): this {
    ;(this.c as HonoCtxWithPending)[PENDING_RESPONSE]
      = this.c.body(body as string | ArrayBuffer | ReadableStream | Uint8Array<ArrayBuffer>)
    return this
  }

  notFound(): this {
    ;(this.c as HonoCtxWithPending)[PENDING_RESPONSE] = new Response(null, { status: 404 })
    return this
  }

  redirect(url: string, status?: number): this {
    ;(this.c as HonoCtxWithPending)[PENDING_RESPONSE] = new Response(null, {
      status: (status ?? 302) as RedirectStatusCode,
      headers: { Location: url },
    })
    return this
  }

  async signedCookie(name: string, value: string, opts?: CookieOptions): Promise<void> {
    const secret = this.cookieSecret
    if (!secret) {
      throw new Error('Cannot write signed cookies: cookieSecret not configured in adapter options')
    }
    await setSignedCookie(this.c, name, value, secret, opts)
  }
}

export class HonoContextRequest<SCHEMA extends HonoRouteSchema = HonoRouteSchema> implements Req<
  IncomingMessage,
  InferParams<SCHEMA>,
  InferQuery<SCHEMA>,
  InferHeaders<SCHEMA>,
  true
> {
  constructor(
    private readonly c: HonoCtx,
    private readonly cookieSecret?: string | string[],
  ) {}

  get raw(): IncomingMessage {
    return this.c.req.raw as unknown as IncomingMessage
  }

  get path(): string {
    return this.c.req.path
  }

  get method(): string {
    return this.c.req.method
  }

  header(): InferHeaders<SCHEMA>
  header(key: string): string | undefined
  header(key?: string): InferHeaders<SCHEMA> | string | undefined {
    if (key === undefined) {
      return this.c.req.header() as InferHeaders<SCHEMA>
    }

    return this.c.req.header(key)
  }

  hasHeader(key: string): boolean {
    return this.c.req.header(key) !== undefined
  }

  param(): InferParams<SCHEMA>
  param(key: string): string | undefined
  param(key?: string): InferParams<SCHEMA> | string | undefined {
    if (key === undefined) {
      return this.c.req.param() as InferParams<SCHEMA>
    }

    return this.c.req.param(key)
  }

  query(): InferQuery<SCHEMA>
  query(key: string): string | undefined
  query(key?: string): InferQuery<SCHEMA> | string | undefined {
    if (key === undefined) {
      const entries = this.c.req.queries()
      const out: Record<string, string> = {}

      for (const [k, v] of Object.entries(entries)) {
        out[k] = Array.isArray(v) ? v[0] ?? '' : v ?? ''
      }

      return out as InferQuery<SCHEMA>
    }

    return this.c.req.query(key)
  }

  queries(key: string): string[] | undefined {
    const val = this.c.req.queries(key)
    if (val === undefined) {
      return undefined
    }

    return Array.isArray(val) ? val : [val]
  }

  cookie(): Record<string, string>
  cookie(name: string): string | undefined
  cookie(name?: string): Record<string, string> | string | undefined {
    if (name === undefined) {
      return getCookie(this.c)
    }

    return getCookie(this.c, name)
  }

  signedCookie(): Promise<Record<string, UnsignedCookie>>
  signedCookie(name: string): Promise<UnsignedCookie>
  signedCookie(name?: string): Promise<Record<string, UnsignedCookie> | UnsignedCookie> {
    const secret = this.cookieSecret
    if (!secret) {
      throw new Error('Cannot read signed cookies: cookieSecret not configured in adapter options')
    }

    if (name !== undefined) {
      return getSignedCookie(this.c, secret, name)
    }

    return getSignedCookie(this.c, secret)
  }
}

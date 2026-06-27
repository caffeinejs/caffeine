import { IncomingMessage } from 'node:http'
import { Context, Req, RouteValidationSchema } from '@caffeinejs/http'
import { Context as HonoCtx } from 'hono'
import type { RedirectStatusCode, StatusCode } from 'hono/utils/http-status'
export interface HonoRouteSchema<
  _TParams = Record<string, string>,
  _TQuery = Record<string, string>,
  _THeaders = Record<string, string>,
  _TBody = unknown,
> extends RouteValidationSchema {}

type InferParams<S> = S extends HonoRouteSchema<infer P, any, any, any> ? P : Record<string, string>
type InferQuery<S> = S extends HonoRouteSchema<any, infer Q, any, any> ? Q : Record<string, string>
type InferHeaders<S> = S extends HonoRouteSchema<any, any, infer H, any> ? H : Record<string, string>

export interface HonoContextHolder {
  response?: Response
}

export class HonoContext<SCHEMA extends HonoRouteSchema = HonoRouteSchema> implements Context<
  IncomingMessage,
  Response
> {
  constructor(
    private readonly c: HonoCtx,
    private readonly holder: HonoContextHolder,
  ) { }

  get req(): HonoContextRequest<SCHEMA> {
    return new HonoContextRequest<SCHEMA>(this.c)
  }

  get res(): Response {
    return this.c.res
  }

  status(code: number): void {
    this.c.status(code as StatusCode)
  }

  header(key: string, value: string): void {
    this.c.header(key, value)
  }

  body(body: string | ArrayBuffer | ReadableStream | Uint8Array<ArrayBuffer>): void {
    this.holder.response = this.c.body(body)
  }

  notFound(): void {
    this.holder.response = new Response(null, { status: 404 })
  }

  redirect(url: string, status?: number): void {
    this.holder.response = new Response(null, {
      status: (status ?? 302) as RedirectStatusCode,
      headers: { Location: url },
    })
  }
}

export class HonoContextRequest<SCHEMA extends HonoRouteSchema = HonoRouteSchema> implements Req<
  IncomingMessage,
  InferParams<SCHEMA>,
  InferQuery<SCHEMA>,
  InferHeaders<SCHEMA>
> {
  constructor(private readonly c: HonoCtx) {}

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
}

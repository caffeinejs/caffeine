import { IncomingMessage } from 'http'
import { Context, Req, RouteValidationSchema } from '@caffeinejs/http'
import { FastifyRequest, FastifyReply, RawReplyDefaultExpression, RawServerDefault, RawRequestDefaultExpression } from 'fastify'

export interface FastifyRouteSchema<
  _TParams = Record<string, string>,
  _TQuery = Record<string, string>,
  _THeaders = Record<string, string>,
  _TBody = unknown,
> extends RouteValidationSchema {}

type InferParams<S> = S extends FastifyRouteSchema<infer P, any, any, any> ? P : Record<string, string>
type InferQuery<S> = S extends FastifyRouteSchema<any, infer Q, any, any> ? Q : Record<string, string>
type InferHeaders<S> = S extends FastifyRouteSchema<any, any, infer H, any> ? H : Record<string, string>

export class FastifyContext<SCHEMA extends FastifyRouteSchema = FastifyRouteSchema> implements Context<
  RawRequestDefaultExpression<RawServerDefault>,
  RawReplyDefaultExpression<RawServerDefault>
> {
  constructor(
    private readonly request: FastifyRequest,
    private readonly reply: FastifyReply,
  ) { }

  get req(): FastifyContextRequest<SCHEMA> {
    return new FastifyContextRequest<SCHEMA>(this.request)
  }

  get res(): RawReplyDefaultExpression<RawServerDefault> {
    return this.reply.raw
  }

  status(code: number): void {
    this.reply.code(code)
  }

  header(key: string, value: string): void {
    this.reply.header(key, value)
  }

  body(body: unknown): void {
    this.reply.send(body)
  }

  notFound(): void {
    this.reply.code(404).send()
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
}

import { IncomingMessage } from 'http'
import { Context, Req } from '@caffeinejs/http'
import { FastifyRequest, FastifyReply, RawReplyDefaultExpression, RawServerDefault, RawRequestDefaultExpression } from 'fastify'

export class FastifyContext implements Context<
  RawRequestDefaultExpression<RawServerDefault>,
  RawReplyDefaultExpression<RawServerDefault>
> {
  constructor(
    private readonly request: FastifyRequest,
    private readonly reply: FastifyReply,
  ) { }

  get req(): FastifyContextRequest {
    return new FastifyContextRequest(this.request)
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

export class FastifyContextRequest implements Req<RawRequestDefaultExpression<RawServerDefault>> {
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

  header(): Record<string, string>
  header(key: string): string | undefined
  header(key?: string): string | Record<string, string> | undefined {
    if (key === undefined) {
      return this.request.headers as Record<string, string>
    }
    return this.request.headers[key] as string | undefined
  }

  param(): Record<string, string>
  param(key: string): string | undefined
  param(key?: string): string | Record<string, string> | undefined {
    if (key === undefined) {
      return this.request.params as Record<string, string>
    }
    return (this.request.params as Record<string, string>)[key]
  }

  query(): Record<string, string>
  query(key: string): string | undefined
  query(key?: string): string | Record<string, string> | undefined {
    if (key === undefined) {
      return this.request.query as Record<string, string>
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

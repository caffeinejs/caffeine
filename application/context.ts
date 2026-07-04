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

export type UnsignedCookie = string | false | undefined

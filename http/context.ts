export interface Req<
  RAW,
  TParams = Record<string, string>,
  TQuery = Record<string, string>,
  THeaders = Record<string, string>,
> {
  get raw(): RAW
  get path(): string
  get method(): string

  query(): TQuery
  query(key: string): string | undefined

  queries(key: string): string[] | undefined

  header(): THeaders
  header(key: string): string | undefined

  param(): TParams
  param(key: string): string | undefined
}

export interface Context<REQ = unknown, RES = unknown> {
  get req(): Req<REQ>

  get res(): RES

  status(code: number): void

  header(key: string, value: string): void

  body(body: unknown): void

  notFound(): void

  redirect(url: string, status?: number): void
}

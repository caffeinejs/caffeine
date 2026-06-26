export class ErrNoRouter extends Error {
  readonly code = 'CAFFEINE_ERR_NO_ROUTER'
  readonly name = 'ErrNoRouter'

  constructor(routerName: string) {
    super(`Cannot build test client: no router found for "${routerName}"`)
  }
}

export class ErrFetchFailed extends Error {
  readonly code = 'CAFFEINE_ERR_FETCH_FAILED'
  readonly status: number
  readonly headers: Headers
  readonly body: unknown

  constructor(message: string, status: number, headers: Headers, body: unknown) {
    super(message)
    this.name = 'ErrFetchFailed'
    this.status = status
    this.headers = headers
    this.body = body
  }
}

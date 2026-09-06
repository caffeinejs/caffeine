export class ErrNoRouter extends Error {
  readonly code = 'CAFFEINE_ERR_NO_ROUTER'
  readonly name = 'ErrNoRouter'

  constructor(routerName: string) {
    super(`Cannot build test client: no router found for "${routerName}"`)
  }
}

export class ErrMissingRouteParam extends Error {
  readonly code = 'CAFFEINE_ERR_MISSING_ROUTE_PARAM'
  readonly name = 'ErrMissingRouteParam'

  constructor(param: string, path: string) {
    super(`Cannot build route URL: missing path parameter ":${param}" for "${path}"`)
  }
}

export class ErrTestClientTarget extends Error {
  readonly code = 'CAFFEINE_ERR_TEST_CLIENT_TARGET'
  readonly name = 'ErrTestClientTarget'

  constructor(detail: string) {
    super(`Cannot build test client: ${detail}`)
  }
}

export class ErrTestClientAlreadyReady extends Error {
  readonly code = 'CAFFEINE_ERR_TEST_CLIENT_ALREADY_READY'
  readonly name = 'ErrTestClientAlreadyReady'

  constructor(option: string) {
    super(
      `Cannot apply "${option}": the application is already ready` +
        '\n\nPossible Solutions:\n - Hand "testClient" the routers instead of an application, so it owns the setup' +
        '\n - Pass the application before calling "ready()" on it',
    )
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

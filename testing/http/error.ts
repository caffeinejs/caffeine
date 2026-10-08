import { errMessage } from '@caffeinejs/std/framework/err'

export class ErrNoRouter extends Error {
  readonly code = 'CAFFEINE_ERR_NO_ROUTER'
  override readonly name = 'ErrNoRouter'

  constructor(routerName: string) {
    super(
      errMessage(`Cannot build test client: no router found for "${routerName}"`)
        .reference('@caffeinejs/testing', ErrNoRouter)
        .build(),
    )
  }
}

export class ErrMissingRouteParam extends Error {
  readonly code = 'CAFFEINE_ERR_MISSING_ROUTE_PARAM'
  override readonly name = 'ErrMissingRouteParam'

  constructor(param: string, path: string) {
    super(
      errMessage(`Cannot build route URL: missing path parameter ":${param}" for "${path}"`)
        .reference('@caffeinejs/testing', ErrMissingRouteParam)
        .build(),
    )
  }
}

export class ErrTestClientTarget extends Error {
  readonly code = 'CAFFEINE_ERR_TEST_CLIENT_TARGET'
  override readonly name = 'ErrTestClientTarget'

  constructor(detail: string) {
    super(
      errMessage(`Cannot build test client: ${detail}`).reference('@caffeinejs/testing', ErrTestClientTarget).build(),
    )
  }
}

export class ErrTestClientAlreadyReady extends Error {
  readonly code = 'CAFFEINE_ERR_TEST_CLIENT_ALREADY_READY'
  override readonly name = 'ErrTestClientAlreadyReady'

  constructor(option: string) {
    super(
      errMessage(`Cannot apply "${option}": the application is already ready`)
        .solutions(
          'Hand "testClient" the routers instead of an application, so it owns the setup',
          'Pass the application before calling "bootstrap()" on it',
        )
        .reference('@caffeinejs/testing', ErrTestClientAlreadyReady)
        .build(),
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

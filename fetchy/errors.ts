export class FetchyError extends Error {
  readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.code = code
  }
}

/**
 * Thrown when a decorator is applied to a class/method/field it does not support
 * (e.g. `@Path` applied to a method, `@GET` applied to a class).
 */
export class ErrFetchyInvalidDecoratorTarget extends FetchyError {
  constructor(decoratorName: string, expected: string) {
    super(`Cannot apply @${decoratorName}: expected ${expected}`, 'ERR_FETCHY_INVALID_DECORATOR_TARGET')
    this.name = 'ErrFetchyInvalidDecoratorTarget'
  }
}

/**
 * Thrown at client build time when a decorated method's configuration is structurally invalid
 * (missing HTTP method, a body on GET/HEAD/OPTIONS, a path parameter with no matching `{key}`
 * placeholder, a form field without `@FormURLEncoded`, more than one `@Body()`, and so on).
 */
export class ErrFetchyInvalidRoute extends FetchyError {
  constructor(method: string, reason: string) {
    super(`Invalid route configuration for method "${method}": ${reason}`, 'ERR_FETCHY_INVALID_ROUTE')
    this.name = 'ErrFetchyInvalidRoute'
  }
}

/**
 * Thrown when `create()` is called on a class with no decorated (GET/POST/etc) methods.
 */
export class ErrFetchyEmptyClient extends FetchyError {
  constructor(className: string) {
    super(`Cannot create client for "${className}": no decorated methods were found`, 'ERR_FETCHY_EMPTY_CLIENT')
    this.name = 'ErrFetchyEmptyClient'
  }
}

/**
 * Thrown when `create()` is called on a class that was never decorated with `@API()`.
 */
export class ErrFetchyMissingAPIDecorator extends FetchyError {
  constructor(className: string) {
    super(
      `Cannot create client for "${className}": missing @API() class decorator`,
      'ERR_FETCHY_MISSING_API_DECORATOR',
    )
    this.name = 'ErrFetchyMissingAPIDecorator'
  }
}

/**
 * Thrown when a parameter descriptor has no matching handling logic. Defensive: unreachable with
 * the fixed set of parameter kinds shipped in v1.
 */
export class ErrFetchyNoParameterHandler extends FetchyError {
  constructor(kind: string, method: string, index: number) {
    super(
      `No parameter handler for kind "${kind}" at index ${index} of method "${method}"`,
      'ERR_FETCHY_NO_PARAMETER_HANDLER',
    )
    this.name = 'ErrFetchyNoParameterHandler'
  }
}

/**
 * Thrown by the default response handler when the underlying HTTP call resolves with a non-ok
 * response. Carries the originating request and response for inspection by callers.
 */
export class ErrFetchyHTTP extends FetchyError {
  readonly request: Request
  readonly status: number
  readonly statusText: string
  readonly headers: Headers
  readonly body: unknown

  constructor(request: Request, response: Response, body: unknown) {
    super(
      `Request "${request.method} ${request.url}" failed with status ${response.status} ${response.statusText}`,
      'ERR_FETCHY_HTTP',
    )
    this.name = 'ErrFetchyHTTP'
    this.request = request
    this.status = response.status
    this.statusText = response.statusText
    this.headers = response.headers
    this.body = body
  }

  toJSON(): object {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      status: this.status,
      statusText: this.statusText,
      body: this.body,
    }
  }
}

/**
 * Thrown when a decorated method is invoked on an instance that was never passed through
 * `FetchyClient.create()` — an explicit failure instead of silently resolving to `undefined`.
 */
export class ErrFetchyClientNotBuilt extends FetchyError {
  constructor(method: string) {
    super(
      `Cannot call method "${method}": the owning class was never passed to FetchyClient.create()`,
      'ERR_FETCHY_CLIENT_NOT_BUILT',
    )
    this.name = 'ErrFetchyClientNotBuilt'
  }
}

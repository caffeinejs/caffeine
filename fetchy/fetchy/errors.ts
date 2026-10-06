import type { FetchyRequest } from './request.js'
import type { FetchyResponse } from './response.js'

/** Base class of every error fetchy throws. */
export class ErrFetchy extends Error {
  readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.name = 'ErrFetchy'
    this.code = code
  }
}

/**
 * Thrown when a decorator is applied to a class/method/field it does not support
 * (e.g. `@API` applied to a method, `@GET` applied to a class).
 */
export class ErrFetchyInvalidDecoratorTarget extends ErrFetchy {
  constructor(decoratorName: string, expected: string) {
    super(`Cannot apply @${decoratorName}: expected ${expected}`, 'ERR_FETCHY_INVALID_DECORATOR_TARGET')
    this.name = 'ErrFetchyInvalidDecoratorTarget'
  }
}

/**
 * Thrown when a decorated method's configuration is structurally invalid. A second HTTP verb on
 * one member is rejected when the class is defined; the rest when the client is built (missing
 * HTTP method, a body on GET/HEAD/OPTIONS, a path parameter with no matching `{key}` placeholder,
 * a form field without `@FormURLEncoded`, more than one `@Body()`, and so on). A client-build
 * failure names the operation as `Class.member`, after the class that declares it.
 */
export class ErrFetchyInvalidRoute extends ErrFetchy {
  constructor(method: string, reason: string) {
    super(`Invalid route configuration for method "${method}": ${reason}`, 'ERR_FETCHY_INVALID_ROUTE')
    this.name = 'ErrFetchyInvalidRoute'
  }
}

/**
 * Thrown when `create()` is called on a class that, with its base classes, declares no operation.
 */
export class ErrFetchyEmptyClient extends ErrFetchy {
  constructor(className: string) {
    super(
      `Cannot create client for "${className}": neither the class nor its base classes declare an operation`,
      'ERR_FETCHY_EMPTY_CLIENT',
    )
    this.name = 'ErrFetchyEmptyClient'
  }
}

/**
 * Thrown when `create()` is called on a class that neither carries `@API()` nor extends a class
 * that does.
 */
export class ErrFetchyMissingAPIDecorator extends ErrFetchy {
  constructor(className: string) {
    super(`Cannot create client for "${className}": missing @API() class decorator`, 'ERR_FETCHY_MISSING_API_DECORATOR')
    this.name = 'ErrFetchyMissingAPIDecorator'
  }
}

/**
 * Thrown by the default response handler when the underlying HTTP call resolves with a non-ok
 * response. Carries the originating request and response for inspection by callers.
 *
 * The message names the request without its query string, which often carries credentials.
 * `request` keeps the whole request but is not enumerable, so a logger that serializes an error's
 * properties leaves its query and body out.
 */
export class ErrFetchyHTTP extends ErrFetchy {
  declare readonly request: FetchyRequest
  readonly status: number
  readonly statusText: string
  readonly headers: Headers
  readonly body: unknown

  constructor(request: FetchyRequest, response: FetchyResponse, body: unknown) {
    const query = request.path.indexOf('?')
    const path = query === -1 ? request.path : request.path.slice(0, query)

    super(
      `Request "${request.method} ${request.origin}${path}" failed with status ${response.status} ${response.statusText}`,
      'ERR_FETCHY_HTTP',
    )
    this.name = 'ErrFetchyHTTP'
    Object.defineProperty(this, 'request', { value: request })
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
 * Thrown when a `@Callback()`-decorated method is invoked without a function as its last
 * argument.
 */
export class ErrFetchyMissingCallbackArgument extends ErrFetchy {
  constructor() {
    super(
      'Cannot invoke a @Callback() method: the last call argument must be a function',
      'ERR_FETCHY_MISSING_CALLBACK_ARGUMENT',
    )
    this.name = 'ErrFetchyMissingCallbackArgument'
  }
}

/**
 * Thrown when an operation is called with `undefined` or `null` for a path parameter. Nothing is
 * sent: `/users/undefined` would name a resource of its own.
 */
export class ErrFetchyMissingPathArgument extends ErrFetchy {
  constructor(method: string, path: string, key: string, value: null | undefined) {
    super(
      `Cannot build request "${method} ${path}": the argument for "{${key}}" is ${value}`,
      'ERR_FETCHY_MISSING_PATH_ARGUMENT',
    )
    this.name = 'ErrFetchyMissingPathArgument'
  }
}

/**
 * Thrown by `FormRequestBodyConverter` when given a flat (non-2D) array — it only accepts an
 * array of `[key, value]` pairs.
 */
export class ErrFetchyInvalidFormBody extends ErrFetchy {
  constructor() {
    super(
      'Cannot convert to application/x-www-form-urlencoded: array body must be an array of [key, value] pairs',
      'ERR_FETCHY_INVALID_FORM_BODY',
    )
    this.name = 'ErrFetchyInvalidFormBody'
  }
}

/**
 * Thrown, synchronously, when an operation is called on something other than a client built by
 * `FetchyClient.create()` that serves it:
 *
 * - an instance constructed with `new` rather than `create()`;
 * - the class's own constructor, which runs before `create()` wires the client;
 * - a method operation called detached from its client, as in `const get = api.get; get()`;
 * - a method operation called with `this` bound to another object.
 */
export class ErrFetchyClientNotBuilt extends ErrFetchy {
  constructor(method: string) {
    super(
      `Cannot call "${method}": "this" is not a client built by FetchyClient.create() that includes it`,
      'ERR_FETCHY_CLIENT_NOT_BUILT',
    )
    this.name = 'ErrFetchyClientNotBuilt'
  }
}

import { errMessage } from './_err_message.gen.js'
import type { FetchyRequest } from './request.js'
import type { FetchyResponse } from './response.js'

// Names a request in a message without its query string, which often carries credentials.
function requestLabel(request: FetchyRequest): string {
  const query = request.path.indexOf('?')
  const path = query === -1 ? request.path : request.path.slice(0, query)

  return `${request.method} ${request.origin}${path}`
}

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
    super(
      errMessage(`Cannot apply @${decoratorName}: expected ${expected}`)
        .reference('@caffeinejs/fetchy', ErrFetchyInvalidDecoratorTarget)
        .build(),
      'ERR_FETCHY_INVALID_DECORATOR_TARGET',
    )
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
    super(
      errMessage(`Invalid route configuration for method "${method}": ${reason}`)
        .reference('@caffeinejs/fetchy', ErrFetchyInvalidRoute)
        .build(),
      'ERR_FETCHY_INVALID_ROUTE',
    )
    this.name = 'ErrFetchyInvalidRoute'
  }
}

/**
 * Thrown when `create()` is called on a class that, with its base classes, declares no operation.
 */
export class ErrFetchyEmptyClient extends ErrFetchy {
  constructor(className: string) {
    super(
      errMessage(`Cannot create client for "${className}": neither the class nor its base classes declare an operation`)
        .reference('@caffeinejs/fetchy', ErrFetchyEmptyClient)
        .build(),
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
    super(
      errMessage(`Cannot create client for "${className}": missing @API() class decorator`)
        .reference('@caffeinejs/fetchy', ErrFetchyMissingAPIDecorator)
        .build(),
      'ERR_FETCHY_MISSING_API_DECORATOR',
    )
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
    super(
      `Request "${requestLabel(request)}" failed with status ${response.status} ${response.statusText}`,
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
 * Thrown when an `Authenticator` returns another follow-up after 3 follow-ups of one request were answered with 401.
 * The message names the request without its query string, which often carries credentials.
 */
export class ErrFetchyTooManyAuthenticationAttempts extends ErrFetchy {
  constructor(request: FetchyRequest, attempts: number) {
    super(
      errMessage(
        `Cannot authenticate "${requestLabel(request)}": the server answered ${attempts} attempts with 401 and the authenticator still returned a follow-up`,
      )
        .solutions(
          'Put the credentials the authenticator obtained on the request it returns',
          'Return null from Authenticator.authenticate() when attempt is greater than 1',
        )
        .reference('@caffeinejs/fetchy', ErrFetchyTooManyAuthenticationAttempts)
        .build(),
      'ERR_FETCHY_TOO_MANY_AUTHENTICATION_ATTEMPTS',
    )
    this.name = 'ErrFetchyTooManyAuthenticationAttempts'
  }
}

/**
 * Thrown when a `@Callback()`-decorated method is invoked without a function as its last
 * argument.
 */
export class ErrFetchyMissingCallbackArgument extends ErrFetchy {
  constructor() {
    super(
      errMessage('Cannot invoke a @Callback() method: the last call argument must be a function')
        .reference('@caffeinejs/fetchy', ErrFetchyMissingCallbackArgument)
        .build(),
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
      errMessage(`Cannot build request "${method} ${path}": the argument for "{${key}}" is ${value}`)
        .reference('@caffeinejs/fetchy', ErrFetchyMissingPathArgument)
        .build(),
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
      errMessage(
        'Cannot convert to application/x-www-form-urlencoded: array body must be an array of [key, value] pairs',
      )
        .reference('@caffeinejs/fetchy', ErrFetchyInvalidFormBody)
        .build(),
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
      errMessage(`Cannot call "${method}": "this" is not a client built by FetchyClient.create() that includes it`)
        .reference('@caffeinejs/fetchy', ErrFetchyClientNotBuilt)
        .build(),
      'ERR_FETCHY_CLIENT_NOT_BUILT',
    )
    this.name = 'ErrFetchyClientNotBuilt'
  }
}

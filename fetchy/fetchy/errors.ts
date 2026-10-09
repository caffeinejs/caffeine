import { errMessage } from './_err_message.gen.js'
import type { FetchyRequest } from './request.js'
import type { FetchyResponse } from './response.js'

// Names a request in a message without its query string, which often carries credentials.
function requestLabel(request: FetchyRequest): string {
  const query = request.path.indexOf('?')
  const path = query === -1 ? request.path : request.path.slice(0, query)

  return `${request.method} ${request.origin}${path}`
}

// Names what a value is without showing it, since a part may carry a secret.
function typeName(value: unknown): string {
  return typeof value === 'object' && value !== null
    ? (Object.getPrototypeOf(value)?.constructor?.name ?? 'Object')
    : typeof value
}

// The fix for a part value that cannot be sent, by what the value most likely is. Bytes come first: a typed array is
// iterable too.
function partSolutions(value: unknown): string[] {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return ["Send bytes as new Blob([bytes]), or as new File([bytes], 'name.bin', { type }) to name them"]
  }

  if (value instanceof Date) {
    return ['Send a date as text: date.toISOString()']
  }

  if (typeof value === 'object' && value !== null) {
    if (Symbol.asyncIterator in value) {
      return [
        'Send a file from disk as the Blob that await fs.openAsBlob(path) returns',
        'Read any other stream into a Blob first: await new Response(stream).blob()',
      ]
    }

    if (Symbol.iterator in value) {
      return ['Pass the items as one flat array, one part each: Array.from(value) or value.flat()']
    }
  }

  return ["Send an object as JSON: new Blob([JSON.stringify(value)], { type: 'application/json' })"]
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
 * a form field without `@FormURLEncoded`, a part without `@Multipart`, more than one `@Body()`, and
 * so on). A client-build failure names the operation as `Class.member`, after the class that
 * declares it.
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
 * response. Carries the request and the response for inspection by callers.
 *
 * `request` is the request the operation built, before interceptors or an authenticator replaced
 * it. `status`, `headers` and `body` come from the response that ended the call, which may answer a
 * retry or an authentication follow-up.
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
 * Thrown when the server answers with 401 every follow-up an `Authenticator` returned for one request, 3 at most. The
 * authenticator is not asked about the last 401. The message names the request without its query string, which often
 * carries credentials.
 */
export class ErrFetchyTooManyAuthenticationAttempts extends ErrFetchy {
  constructor(request: FetchyRequest, followUps: number) {
    super(
      errMessage(
        `Cannot authenticate "${requestLabel(request)}": the server answered all ${followUps} follow-ups with 401, and fetchy sends no more`,
      )
        .solutions(
          'Return null from Authenticator.authenticate() once attempt is past the rounds the scheme needs: 2 covers the token held, then a refreshed one, and a Digest nonce gone stale',
          'Put the credentials the authenticator obtained on the request it returns',
        )
        .reference('@caffeinejs/fetchy', ErrFetchyTooManyAuthenticationAttempts)
        .build(),
      'ERR_FETCHY_TOO_MANY_AUTHENTICATION_ATTEMPTS',
    )
    this.name = 'ErrFetchyTooManyAuthenticationAttempts'
  }
}

/**
 * Thrown when fetchy refuses to send the follow-up an `Authenticator` returned: it targets another origin than the
 * call's, or its body is a stream or an iterator the first send may have read. The message names the request without
 * its query string, which often carries credentials.
 */
export class ErrFetchyFollowUpNotSent extends ErrFetchy {
  constructor(request: FetchyRequest, problem: 'origin' | 'body') {
    const first = `Cannot send the authentication follow-up of "${requestLabel(request)}"`
    // Names the call's own origin only: the one the authenticator built may carry anything.
    const message =
      problem === 'origin'
        ? errMessage(`${first}: it does not target "${request.origin}"`).solutions(
            'Build the follow-up with request.clone(), which keeps the origin',
          )
        : errMessage(`${first}: its body is a stream or an iterator, which the first send may have read`).solutions(
            'Add the credentials with an interceptor, before the first send, so a streamed body needs no follow-up',
            'Send the body as a string, bytes or a Blob, which fetchy can send again',
          )

    super(message.reference('@caffeinejs/fetchy', ErrFetchyFollowUpNotSent).build(), 'ERR_FETCHY_FOLLOW_UP_NOT_SENT')
    this.name = 'ErrFetchyFollowUpNotSent'
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
 * Thrown by `FormRequestBodyConverter` when given a flat (non-2D) array, since it only accepts an
 * array of `[key, value]` pairs, or a `FormData`, which `@Multipart()` sends.
 */
export class ErrFetchyInvalidFormBody extends ErrFetchy {
  constructor(problem: 'pairs' | 'form-data') {
    const message =
      problem === 'pairs'
        ? errMessage(
            'Cannot convert to application/x-www-form-urlencoded: array body must be an array of [key, value] pairs',
          )
        : errMessage(
            'Cannot convert a FormData to application/x-www-form-urlencoded: FormData is sent as multipart/form-data',
          ).solutions('Use @Multipart() instead of @FormURLEncoded() or FormRequestBodyConverter')

    super(message.reference('@caffeinejs/fetchy', ErrFetchyInvalidFormBody).build(), 'ERR_FETCHY_INVALID_FORM_BODY')
    this.name = 'ErrFetchyInvalidFormBody'
  }
}

/**
 * Thrown when an operation under `@Multipart()` is called with a body fetchy cannot encode: a part
 * value that is not a string, number, boolean, bigint, `Blob` or `File`, or a `@Body()` value that
 * is neither the global `FormData` nor a plain object. Nothing is sent. The message names the
 * value's type, never the value.
 */
export class ErrFetchyInvalidMultipartBody extends ErrFetchy {
  /**
   * @param part - The part the value was given for, or `undefined` for a `@Body()` value
   */
  constructor(value: unknown, part?: string) {
    const message =
      part !== undefined
        ? errMessage(
            `Cannot add part "${part}" to the multipart body: expected a string, number, boolean, bigint, Blob or File, got ${typeName(value)}`,
          ).solutions(...partSolutions(value))
        : Object.prototype.toString.call(value) === '[object FormData]'
          ? errMessage(
              'Cannot convert the @Body() value to multipart/form-data: it is a FormData from another implementation, such as the one undici exports',
            ).solutions('Build the body with the global FormData')
          : errMessage(
              `Cannot convert the @Body() value to multipart/form-data: expected a FormData or a plain object, got ${typeName(value)}`,
            ).solutions('Pass a FormData, or a plain object with one property per part')

    super(
      message.reference('@caffeinejs/fetchy', ErrFetchyInvalidMultipartBody).build(),
      'ERR_FETCHY_INVALID_MULTIPART_BODY',
    )
    this.name = 'ErrFetchyInvalidMultipartBody'
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

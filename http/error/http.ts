import { STATUS_CODES } from 'node:http'

import { ErrCaffeineWebApplication } from './common.js'

export interface ErrHTTPOptions {
  cause?: unknown
  body?: unknown
  headers?: Record<string, string>
  code?: string
}

export class ErrHTTP extends ErrCaffeineWebApplication {
  override readonly cause?: unknown
  readonly body?: unknown
  readonly headers?: Record<string, string>

  constructor(
    readonly statusCode: number,
    message: string,
    options?: ErrHTTPOptions,
  ) {
    super(message, options?.code ?? 'ERR_HTTP')
    this.name = 'ErrHTTP'
    this.cause = options?.cause
    this.body = options?.body
    this.headers = options?.headers
  }

  static builder() {
    return new ErrHTTPBuilder()
  }
}

export class ErrHTTPBuilder {
  #statusCode: number = 500
  #message: string = ''
  #options: ErrHTTPOptions = {}

  statusCode(statusCode: number) {
    this.#statusCode = statusCode
    return this
  }

  message(message: string) {
    this.#message = message
    return this
  }

  cause(cause: unknown) {
    this.#options.cause = cause
    return this
  }

  body(body: unknown) {
    this.#options.body = body
    return this
  }

  headers(headers: Record<string, string>) {
    this.#options.headers = headers
    return this
  }

  code(code: string) {
    this.#options.code = code
    return this
  }

  options(options: ErrHTTPOptions) {
    this.#options = { ...this.#options, ...options }
    return this
  }

  build(): ErrHTTP {
    return new ErrHTTP(this.#statusCode, this.#message, { ...this.#options })
  }
}

export function newHTTPError(): ErrHTTPBuilder {
  return new ErrHTTPBuilder()
}

/**
 * The response body an {@link ErrHTTP} renders to when it does not carry its own {@link ErrHTTPOptions.body}.
 *
 * One shape for every 404 the application can produce — one thrown by a handler, one from a URL that matched
 * no route, and `ctx.notFound()` — so a client parses a single envelope rather than three.
 */
export interface HTTPErrorBody {
  statusCode: number
  /** The HTTP status phrase, e.g. `"Not Found"`. The detail belongs in {@link message}. */
  error: string
  code: string
  message: string
}

/**
 * Renders the default body for an {@link ErrHTTP}.
 *
 * `error` is the status phrase and `message` the detail, as Fastify's own errors are shaped — the two are not
 * interchangeable, and a client that switches on `error` needs it stable across every error of a given status.
 */
export function httpErrorBody(err: ErrHTTP): HTTPErrorBody {
  return {
    statusCode: err.statusCode,
    error: STATUS_CODES[err.statusCode] ?? 'Error',
    code: err.code,
    message: err.message,
  }
}

/**
 * Renders the default body for a bare status code, for the response shorthands on `Context` that never build
 * an error object.
 */
export function statusErrorBody(statusCode: number, code: string, message?: string): HTTPErrorBody {
  const phrase = STATUS_CODES[statusCode] ?? 'Error'

  return { statusCode, error: phrase, code, message: message ?? phrase }
}

// 4xx Client Errors
// ---

export class ErrHTTPBadRequest extends ErrHTTP {
  constructor(message: string = 'Bad Request', options?: ErrHTTPOptions) {
    super(400, message, { code: 'ERR_HTTP_BAD_REQUEST', ...options })
    this.name = 'ErrHTTPBadRequest'
  }
}

export class ErrHTTPUnauthorized extends ErrHTTP {
  constructor(message: string = 'Unauthorized', options?: ErrHTTPOptions) {
    super(401, message, { code: 'ERR_HTTP_UNAUTHORIZED', ...options })
    this.name = 'ErrHTTPUnauthorized'
  }
}

export class ErrHTTPPaymentRequired extends ErrHTTP {
  constructor(message: string = 'Payment Required', options?: ErrHTTPOptions) {
    super(402, message, { code: 'ERR_HTTP_PAYMENT_REQUIRED', ...options })
    this.name = 'ErrHTTPPaymentRequired'
  }
}

export class ErrHTTPForbidden extends ErrHTTP {
  constructor(message: string = 'Forbidden', options?: ErrHTTPOptions) {
    super(403, message, { code: 'ERR_HTTP_FORBIDDEN', ...options })
    this.name = 'ErrHTTPForbidden'
  }
}

export class ErrHTTPNotFound extends ErrHTTP {
  constructor(message: string = 'Not Found', options?: ErrHTTPOptions) {
    super(404, message, { code: 'ERR_HTTP_NOT_FOUND', ...options })
    this.name = 'ErrHTTPNotFound'
  }
}

export class ErrHTTPMethodNotAllowed extends ErrHTTP {
  constructor(message: string = 'Method Not Allowed', options?: ErrHTTPOptions) {
    super(405, message, { code: 'ERR_HTTP_METHOD_NOT_ALLOWED', ...options })
    this.name = 'ErrHTTPMethodNotAllowed'
  }
}

export class ErrHTTPNotAcceptable extends ErrHTTP {
  constructor(message: string = 'Not Acceptable', options?: ErrHTTPOptions) {
    super(406, message, { code: 'ERR_HTTP_NOT_ACCEPTABLE', ...options })
    this.name = 'ErrHTTPNotAcceptable'
  }
}

export class ErrHTTPProxyAuthenticationRequired extends ErrHTTP {
  constructor(message: string = 'Proxy Authentication Required', options?: ErrHTTPOptions) {
    super(407, message, { code: 'ERR_HTTP_PROXY_AUTHENTICATION_REQUIRED', ...options })
    this.name = 'ErrHTTPProxyAuthenticationRequired'
  }
}

export class ErrHTTPRequestTimeout extends ErrHTTP {
  constructor(message: string = 'Request Timeout', options?: ErrHTTPOptions) {
    super(408, message, { code: 'ERR_HTTP_REQUEST_TIMEOUT', ...options })
    this.name = 'ErrHTTPRequestTimeout'
  }
}

export class ErrHTTPConflict extends ErrHTTP {
  constructor(message: string = 'Conflict', options?: ErrHTTPOptions) {
    super(409, message, { code: 'ERR_HTTP_CONFLICT', ...options })
    this.name = 'ErrHTTPConflict'
  }
}

export class ErrHTTPGone extends ErrHTTP {
  constructor(message: string = 'Gone', options?: ErrHTTPOptions) {
    super(410, message, { code: 'ERR_HTTP_GONE', ...options })
    this.name = 'ErrHTTPGone'
  }
}

export class ErrHTTPPreconditionFailed extends ErrHTTP {
  constructor(message: string = 'Precondition Failed', options?: ErrHTTPOptions) {
    super(412, message, { code: 'ERR_HTTP_PRECONDITION_FAILED', ...options })
    this.name = 'ErrHTTPPreconditionFailed'
  }
}

export class ErrHTTPPayloadTooLarge extends ErrHTTP {
  constructor(message: string = 'Payload Too Large', options?: ErrHTTPOptions) {
    super(413, message, { code: 'ERR_HTTP_PAYLOAD_TOO_LARGE', ...options })
    this.name = 'ErrHTTPPayloadTooLarge'
  }
}

export class ErrHTTPUnsupportedMediaType extends ErrHTTP {
  constructor(message: string = 'Unsupported Media Type', options?: ErrHTTPOptions) {
    super(415, message, { code: 'ERR_HTTP_UNSUPPORTED_MEDIA_TYPE', ...options })
    this.name = 'ErrHTTPUnsupportedMediaType'
  }
}

export class ErrHTTPImATeapot extends ErrHTTP {
  constructor(message: string = "I'm a Teapot", options?: ErrHTTPOptions) {
    super(418, message, { code: 'ERR_HTTP_IM_A_TEAPOT', ...options })
    this.name = 'ErrHTTPImATeapot'
  }
}

export class ErrHTTPMisdirectedRequest extends ErrHTTP {
  constructor(message: string = 'Misdirected Request', options?: ErrHTTPOptions) {
    super(421, message, { code: 'ERR_HTTP_MISDIRECTED_REQUEST', ...options })
    this.name = 'ErrHTTPMisdirectedRequest'
  }
}

export class ErrHTTPUnprocessableEntity extends ErrHTTP {
  constructor(message: string = 'Unprocessable Entity', options?: ErrHTTPOptions) {
    super(422, message, { code: 'ERR_HTTP_UNPROCESSABLE_ENTITY', ...options })
    this.name = 'ErrHTTPUnprocessableEntity'
  }
}

export class ErrHTTPLocked extends ErrHTTP {
  constructor(message: string = 'Locked', options?: ErrHTTPOptions) {
    super(423, message, { code: 'ERR_HTTP_LOCKED', ...options })
    this.name = 'ErrHTTPLocked'
  }
}

export class ErrHTTPFailedDependency extends ErrHTTP {
  constructor(message: string = 'Failed Dependency', options?: ErrHTTPOptions) {
    super(424, message, { code: 'ERR_HTTP_FAILED_DEPENDENCY', ...options })
    this.name = 'ErrHTTPFailedDependency'
  }
}

export class ErrHTTPTooManyRequests extends ErrHTTP {
  constructor(message: string = 'Too Many Requests', options?: ErrHTTPOptions) {
    super(429, message, { code: 'ERR_HTTP_TOO_MANY_REQUESTS', ...options })
    this.name = 'ErrHTTPTooManyRequests'
  }
}

// 5xx Server Errors
// ---

export class ErrHTTPInternalServerError extends ErrHTTP {
  constructor(message: string = 'Internal Server Error', options?: ErrHTTPOptions) {
    super(500, message, { code: 'ERR_HTTP_INTERNAL_SERVER_ERROR', ...options })
    this.name = 'ErrHTTPInternalServerError'
  }
}

export class ErrHTTPNotImplemented extends ErrHTTP {
  constructor(message: string = 'Not Implemented', options?: ErrHTTPOptions) {
    super(501, message, { code: 'ERR_HTTP_NOT_IMPLEMENTED', ...options })
    this.name = 'ErrHTTPNotImplemented'
  }
}

export class ErrHTTPBadGateway extends ErrHTTP {
  constructor(message: string = 'Bad Gateway', options?: ErrHTTPOptions) {
    super(502, message, { code: 'ERR_HTTP_BAD_GATEWAY', ...options })
    this.name = 'ErrHTTPBadGateway'
  }
}

export class ErrHTTPServiceUnavailable extends ErrHTTP {
  constructor(message: string = 'Service Unavailable', options?: ErrHTTPOptions) {
    super(503, message, { code: 'ERR_HTTP_SERVICE_UNAVAILABLE', ...options })
    this.name = 'ErrHTTPServiceUnavailable'
  }
}

export class ErrHTTPGatewayTimeout extends ErrHTTP {
  constructor(message: string = 'Gateway Timeout', options?: ErrHTTPOptions) {
    super(504, message, { code: 'ERR_HTTP_GATEWAY_TIMEOUT', ...options })
    this.name = 'ErrHTTPGatewayTimeout'
  }
}

export class ErrHTTPVersionNotSupported extends ErrHTTP {
  constructor(message: string = 'HTTP Version Not Supported', options?: ErrHTTPOptions) {
    super(505, message, { code: 'ERR_HTTP_VERSION_NOT_SUPPORTED', ...options })
    this.name = 'ErrHTTPVersionNotSupported'
  }
}

export class ErrHTTPInsufficientStorage extends ErrHTTP {
  constructor(message: string = 'Insufficient Storage', options?: ErrHTTPOptions) {
    super(507, message, { code: 'ERR_HTTP_INSUFFICIENT_STORAGE', ...options })
    this.name = 'ErrHTTPInsufficientStorage'
  }
}

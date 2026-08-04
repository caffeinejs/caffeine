import { ErrCaffeineWebApplication } from './common.js'

export interface ErrHTTPOptions {
  cause?: unknown
  body?: unknown
  headers?: Record<string, string>
  code?: string
}

export class ErrHTTP extends ErrCaffeineWebApplication {
  readonly cause?: unknown
  readonly body?: unknown
  readonly headers?: Record<string, string>

  constructor(readonly statusCode: number, message: string, options?: ErrHTTPOptions) {
    super(message, options?.code ?? 'HTTP_ERROR')
    this.cause = options?.cause
    this.body = options?.body
    this.headers = options?.headers ?? {}
  }
}

// 4xx Client Errors
// ---

export class ErrBadRequest extends ErrHTTP {
  constructor(message: string = 'Bad Request', options?: ErrHTTPOptions) {
    super(400, message, options)
  }
}

export class ErrUnauthorized extends ErrHTTP {
  constructor(message: string = 'Unauthorized', options?: ErrHTTPOptions) {
    super(401, message, options)
  }
}

export class ErrPaymentRequired extends ErrHTTP {
  constructor(message: string = 'Payment Required', options?: ErrHTTPOptions) {
    super(402, message, options)
  }
}

export class ErrForbidden extends ErrHTTP {
  constructor(message: string = 'Forbidden', options?: ErrHTTPOptions) {
    super(403, message, options)
  }
}

export class ErrNotFound extends ErrHTTP {
  constructor(message: string = 'Not Found', options?: ErrHTTPOptions) {
    super(404, message, options)
  }
}

export class ErrMethodNotAllowed extends ErrHTTP {
  constructor(message: string = 'Method Not Allowed', options?: ErrHTTPOptions) {
    super(405, message, options)
  }
}

export class ErrNotAcceptable extends ErrHTTP {
  constructor(message: string = 'Not Acceptable', options?: ErrHTTPOptions) {
    super(406, message, options)
  }
}

export class ErrProxyAuthenticationRequired extends ErrHTTP {
  constructor(message: string = 'Proxy Authentication Required', options?: ErrHTTPOptions) {
    super(407, message, options)
  }
}

export class ErrRequestTimeout extends ErrHTTP {
  constructor(message: string = 'Request Timeout', options?: ErrHTTPOptions) {
    super(408, message, options)
  }
}

export class ErrConflict extends ErrHTTP {
  constructor(message: string = 'Conflict', options?: ErrHTTPOptions) {
    super(409, message, options)
  }
}

export class ErrGone extends ErrHTTP {
  constructor(message: string = 'Gone', options?: ErrHTTPOptions) {
    super(410, message, options)
  }
}

export class ErrPreconditionFailed extends ErrHTTP {
  constructor(message: string = 'Precondition Failed', options?: ErrHTTPOptions) {
    super(412, message, options)
  }
}

export class ErrPayloadTooLarge extends ErrHTTP {
  constructor(message: string = 'Payload Too Large', options?: ErrHTTPOptions) {
    super(413, message, options)
  }
}

export class ErrUnsupportedMediaType extends ErrHTTP {
  constructor(message: string = 'Unsupported Media Type', options?: ErrHTTPOptions) {
    super(415, message, options)
  }
}

export class ErrImATeapot extends ErrHTTP {
  constructor(message: string = 'I\'m a Teapot', options?: ErrHTTPOptions) {
    super(418, message, options)
  }
}

export class ErrMisdirectedRequest extends ErrHTTP {
  constructor(message: string = 'Misdirected Request', options?: ErrHTTPOptions) {
    super(421, message, options)
  }
}

export class ErrUnprocessableEntity extends ErrHTTP {
  constructor(message: string = 'Unprocessable Entity', options?: ErrHTTPOptions) {
    super(422, message, options)
  }
}

export class ErrLocked extends ErrHTTP {
  constructor(message: string = 'Locked', options?: ErrHTTPOptions) {
    super(423, message, options)
  }
}

export class ErrFailedDependency extends ErrHTTP {
  constructor(message: string = 'Failed Dependency', options?: ErrHTTPOptions) {
    super(424, message, options)
  }
}

export class ErrTooManyRequests extends ErrHTTP {
  constructor(message: string = 'Too Many Requests', options?: ErrHTTPOptions) {
    super(429, message, options)
  }
}

// 5xx Server Errors
// ---

export class ErrInternalServerError extends ErrHTTP {
  constructor(message: string = 'Internal Server Error', options?: ErrHTTPOptions) {
    super(500, message, options)
  }
}

export class ErrNotImplemented extends ErrHTTP {
  constructor(message: string = 'Not Implemented', options?: ErrHTTPOptions) {
    super(501, message, options)
  }
}

export class ErrBadGateway extends ErrHTTP {
  constructor(message: string = 'Bad Gateway', options?: ErrHTTPOptions) {
    super(502, message, options)
  }
}

export class ErrServiceUnavailable extends ErrHTTP {
  constructor(message: string = 'Service Unavailable', options?: ErrHTTPOptions) {
    super(503, message, options)
  }
}

export class ErrGatewayTimeout extends ErrHTTP {
  constructor(message: string = 'Gateway Timeout', options?: ErrHTTPOptions) {
    super(504, message, options)
  }
}

export class ErrHTTPVersionNotSupported extends ErrHTTP {
  constructor(message: string = 'HTTP Version Not Supported', options?: ErrHTTPOptions) {
    super(505, message, options)
  }
}

export class ErrInsufficientStorage extends ErrHTTP {
  constructor(message: string = 'Insufficient Storage', options?: ErrHTTPOptions) {
    super(507, message, options)
  }
}

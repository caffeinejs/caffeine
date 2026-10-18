import {
  ErrFetchyHTTP,
  type Chain,
  type FetchyRequest,
  type FetchyResponse,
  type Interceptor,
  MediaTypes,
} from '@caffeinejs/fetchy'

import { ConsoleLogger } from './console_logger.js'
import { ErrFetchyLoggingInvalidRedactHeaderArgs } from './errors.js'
import { Level } from './level.js'
import type { Logger } from './logger.js'

export interface LoggingInterceptorInit {
  level?: Level
  headersToRedact?: Set<string>
  /**
   * Where the lines go: a {@link ConsoleLogger} unless given. `PinoLogger`, from
   * `@caffeinejs/fetchy-logging-interceptor/pino`, writes them through pino.
   */
  logger?: Logger
}

const TEXTUAL_CONTENT_TYPES = [MediaTypes.JSON, MediaTypes.FORM_URL_ENCODED, MediaTypes.TEXT_PLAIN]

function isTextual(contentType: string | null): boolean {
  if (!contentType) {
    return false
  }

  const lower = contentType.toLowerCase()
  return TEXTUAL_CONTENT_TYPES.some(type => lower.includes(type)) || lower.includes('text/') || lower.includes('+json')
}

// A failed call's body as the response converter read it, as text: undefined for a value JSON cannot write, such as a
// BigInt or a cycle.
function errorBodyText(body: unknown): string | undefined {
  if (typeof body === 'string') {
    return body
  }

  try {
    return JSON.stringify(body)
  } catch {
    return undefined
  }
}

/**
 * OkHttp-style request/response logging interceptor for `@caffeinejs/fetchy`.
 *
 * A call that fails with {@link ErrFetchyHTTP} is logged as its response would be: the status line, the headers,
 * redacted as set, and at `Level.BODY` the body. The logger is not handed that error, which it would write whole. Any
 * other error is handed over, so its type, code, stack and cause reach the log.
 */
export class LoggingInterceptor implements Interceptor {
  static readonly DEFAULT: LoggingInterceptor = new LoggingInterceptor()

  level: Level
  readonly logger: Logger
  private readonly headersToRedact: Set<string>

  constructor(init: LoggingInterceptorInit = {}) {
    this.level = init.level ?? Level.BASIC
    this.headersToRedact = init.headersToRedact ?? new Set()
    this.logger = init.logger ?? new ConsoleLogger()
  }

  setLevel(level: Level): void {
    this.level = level
  }

  redactHeader(...names: string[]): void {
    if (names.length === 0) {
      throw new ErrFetchyLoggingInvalidRedactHeaderArgs()
    }

    for (const name of names) {
      this.headersToRedact.add(name.toLowerCase())
    }
  }

  async intercept(chain: Chain): Promise<FetchyResponse> {
    const request = chain.request()

    if (this.level === Level.NONE) {
      return chain.proceed(request)
    }

    const logHeaders = this.level === Level.HEADERS || this.level === Level.BODY
    const logBody = this.level === Level.BODY

    this.logger.info(`--> ${request.method} ${request.url}`)

    if (logHeaders) {
      this.logRequestHeaders(request)
    }

    if (logBody) {
      this.logRequestBody(request, `--> END ${request.method}`)
    } else {
      this.logger.info(`--> END ${request.method}`)
    }

    const start = performance.now()

    try {
      const response = await chain.proceed(request)
      const took = performance.now() - start

      this.logger.info(`<-- ${response.status}${response.statusText ? ` ${response.statusText}` : ''} ${request.url}`)

      if (logHeaders) {
        for (const [name, value] of response.headers) {
          this.logHeader(name, value)
        }
      }

      this.logger.info(`Took: ${took}ms`)
      this.logger.info(`Body Size: ${response.headers.get('content-length') ?? 'unknown-length'}`)

      let logged = response

      if (logBody) {
        logged = await this.logResponseBody(response, '<-- END HTTP')
      } else {
        this.logger.info('<-- END HTTP')
      }

      this.logger.info('')

      return logged
    } catch (err) {
      const took = performance.now() - start

      if (err instanceof ErrFetchyHTTP) {
        this.logger.error(`<-- ${err.status}${err.statusText ? ` ${err.statusText}` : ''} ${request.url}`)

        if (logHeaders) {
          for (const [name, value] of err.headers) {
            this.logHeader(name, value, true)
          }
        }

        if (logBody) {
          this.logErrorBody(err.body)
        }
      }

      this.logger.error(`Took: ${took}ms`)
      // An ErrFetchyHTTP carries the response's headers and body, logged above as far as the level and the redactions
      // allow. Handed to the logger, it would be written whole.
      this.logger.error(
        `<-- HTTP Failed: ${(err as Error).message}`,
        err instanceof ErrFetchyHTTP ? undefined : (err as Error),
      )
      this.logger.error('')

      throw err
    }
  }

  private logRequestHeaders(request: FetchyRequest): void {
    const contentType = request.headers.get('content-type')
    const contentLength = request.headers.get('content-length')

    if (request.body !== null && request.body !== undefined) {
      if (contentType) {
        this.logger.info(`Content-Type: ${contentType}`)
      }

      if (contentLength) {
        this.logger.info(`Content-Length: ${contentLength}`)
      }
    }

    for (const [name, value] of request.headers) {
      this.logHeader(name, value)
    }
  }

  private logRequestBody(request: FetchyRequest, endLine: string): void {
    const { body } = request

    if (body === null || body === undefined) {
      this.logger.info(endLine)
      return
    }

    if (typeof body !== 'string' || !isTextual(request.headers.get('content-type'))) {
      this.logger.info(`${endLine} (body omitted)`)
      return
    }

    this.logBodyText(body, endLine)
  }

  // Reading the body consumes it, so the caller gets a fresh response carrying the text that was read.
  private async logResponseBody(response: FetchyResponse, endLine: string): Promise<FetchyResponse> {
    if (response.body === null) {
      this.logger.info(endLine)
      return response
    }

    if (!isTextual(response.headers.get('content-type'))) {
      this.logger.info(`${endLine} (body omitted)`)
      return response
    }

    const text = await response.text()
    this.logBodyText(text, endLine)

    return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers })
  }

  // The response converter has read the bytes the server sent into a value by now, so the end line counts none.
  private logErrorBody(body: unknown): void {
    if (body === undefined || body === null) {
      this.logger.error('<-- END HTTP')
      return
    }

    const text = errorBodyText(body)

    if (text === undefined) {
      this.logger.error('<-- END HTTP (body omitted)')
      return
    }

    this.logger.error(text)
    this.logger.error('<-- END HTTP')
  }

  private logBodyText(text: string, endLine: string): void {
    this.logger.info(text)
    this.logger.info(`${endLine} (${new TextEncoder().encode(text).length}-byte body)`)
  }

  private logHeader(name: string, value: string, isErr = false): void {
    const line = this.headersToRedact.has(name.toLowerCase()) ? `${name}: ***` : `${name}: ${value}`

    if (isErr) {
      this.logger.error(line)
    } else {
      this.logger.info(line)
    }
  }
}

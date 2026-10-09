import {
  ErrFetchyHTTP,
  type Chain,
  type FetchyRequest,
  type FetchyResponse,
  type Interceptor,
  MediaTypes,
} from '@caffeinejs/fetchy'

import { ErrFetchyLoggingInvalidRedactHeaderArgs } from './errors.js'
import { Level } from './level.js'
import type { Logger } from './logger.js'
import { PinoLogger } from './pino_logger.js'

export interface LoggingInterceptorInit {
  level?: Level
  headersToRedact?: Set<string>
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

/**
 * OkHttp-style request/response logging interceptor for `@caffeinejs/fetchy`.
 */
export class LoggingInterceptor implements Interceptor {
  static readonly DEFAULT: LoggingInterceptor = new LoggingInterceptor()

  level: Level
  readonly logger: Logger
  private readonly headersToRedact: Set<string>

  constructor(init: LoggingInterceptorInit = {}) {
    this.level = init.level ?? Level.BASIC
    this.headersToRedact = init.headersToRedact ?? new Set()
    this.logger = init.logger ?? new PinoLogger(PinoLogger.DEFAULT_OPTIONS)
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
      }

      this.logger.error(`Took: ${took}ms`)
      this.logger.error(`<-- HTTP Failed: ${(err as Error).message}`, err as Error)
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

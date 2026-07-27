import { ErrFetchyHTTP, type Chain, type Interceptor, MediaTypes } from '@caffeinejs/fetchy'

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

function now(): number {
  if (typeof process !== 'undefined' && typeof process.hrtime?.bigint === 'function') {
    return Number(process.hrtime.bigint()) / 1_000_000
  }

  return Date.now()
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

  async intercept(chain: Chain): Promise<Response> {
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
      await this.logBodyTail(request, `--> END ${request.method}`)
    } else {
      this.logger.info(`--> END ${request.method}`)
    }

    const start = now()

    try {
      const response = await chain.proceed(request)
      const took = now() - start

      this.logger.info(`<-- ${response.status}${response.statusText ? ` ${response.statusText}` : ''} ${response.url}`)

      if (logHeaders) {
        for (const [name, value] of response.headers) {
          this.logHeader(name, value)
        }
      }

      this.logger.info(`Took: ${took}ms`)
      this.logger.info(`Body Size: ${response.headers.get('content-length') ?? 'unknown-length'}`)

      if (logBody) {
        await this.logBodyTail(response, '<-- END HTTP')
      } else {
        this.logger.info('<-- END HTTP')
      }

      this.logger.info('')

      return response
    } catch (err) {
      const took = now() - start

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

  private logRequestHeaders(request: Request): void {
    const contentType = request.headers.get('content-type')
    const contentLength = request.headers.get('content-length')

    if (request.body !== null) {
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

  private async logBodyTail(withBody: Request | Response, endLine: string): Promise<void> {
    if (withBody.body === null) {
      this.logger.info(endLine)
      return
    }

    if (!isTextual(withBody.headers.get('content-type'))) {
      this.logger.info(`${endLine} (body omitted)`)
      return
    }

    const text = await withBody.clone().text()
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

import { Catch, ErrHTTP, type ErrorHandler, type HTTPErrorBody, type IContext, statusErrorBody } from '@caffeinejs/http'
import { Second } from '@caffeinejs/std/duration'

import { ErrCallRefused, failureOf } from '../errors.js'
import { ErrTimeLimitExceeded } from '../timelimiter/timelimiter.js'

/**
 * Answers a refusal (`ErrCallRefused`: an open circuit breaker, a full bulkhead, a spent rate limit) with 503, and a
 * time limit (`ErrTimeLimitExceeded`) with 504.
 *
 * A refusal that knows how long to wait sets `Retry-After`, in whole seconds rounded up. The body is the default JSON
 * envelope with the error's `code` and the status phrase as its message: the names of breakers and dependencies
 * never reach a client. Enrol it with `.errorHandling(e => e.globalHandlers(ResilienceErrorHandler))`.
 */
@Catch([ErrCallRefused, ErrTimeLimitExceeded])
export class ResilienceErrorHandler implements ErrorHandler<ErrCallRefused | ErrTimeLimitExceeded> {
  handle(ctx: IContext, error: ErrCallRefused | ErrTimeLimitExceeded): HTTPErrorBody {
    const { kind, code, retryAfter } = failureOf(error)!
    if (kind === 'timeout') {
      ctx.status(504)
      return statusErrorBody(504, code)
    }

    ctx.status(503)
    if (retryAfter !== undefined) {
      ctx.header('retry-after', String(Math.max(1, Math.ceil(retryAfter / Second))))
    }
    return statusErrorBody(503, code)
  }
}

/**
 * Whether an error is a 4xx answer to the client rather than a failing dependency. Pass it where a client's mistake
 * must not count against a dependency: `retryOn: error => !isClientError(error)`, `ignoreError: isClientError` on a
 * circuit breaker, `on: error => !isClientError(error)` on a fallback. Nothing applies it by default.
 *
 * An {@link ErrHTTP} with a 4xx status is the application's own answer, so it is a client error, 408 and 429 included.
 * Any other error is one when it carries a numeric `status` or `statusCode` from 400 to 499, except 408 and 429: a
 * dependency that timed out or throttled is failing for now, and retries and the breaker must still see it.
 */
export function isClientError(error: unknown): boolean {
  if (error instanceof ErrHTTP) {
    return isClientStatus(error.statusCode)
  }
  if (typeof error !== 'object' || error === null) {
    return false
  }
  const { status, statusCode } = error as { status?: unknown; statusCode?: unknown }
  const code = typeof status === 'number' ? status : statusCode
  return typeof code === 'number' && isClientStatus(code) && code !== 408 && code !== 429
}

function isClientStatus(status: number): boolean {
  return status >= 400 && status < 500
}

import { Catch, type ErrorHandler, type HTTPErrorBody, type IContext, statusErrorBody } from '@caffeinejs/http'
import { Second } from '@caffeinejs/std/duration'

import { ErrCallRefused } from '../errors.js'
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
    if (error instanceof ErrTimeLimitExceeded) {
      ctx.status(504)
      return statusErrorBody(504, error.code)
    }

    ctx.status(503)
    if (error.retryAfter !== undefined) {
      ctx.header('retry-after', String(Math.max(1, Math.ceil(error.retryAfter / Second))))
    }
    return statusErrorBody(503, error.code)
  }
}

import { classOrMember } from '../decorators/decorator_util.js'
import { configureClass, configureMethod } from '../decorators/registrar/registrar.js'
import { ErrFetchyInvalidDecoratorTarget } from '../errors.js'
import { ErrFetchyInvalidRetryOptions } from './errors.js'
import { DEFAULT_RETRY_OPTIONS, type RetryOptions } from './options.js'

// An HTTP token (RFC 9110), the names `Headers` accepts.
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

/**
 * Opts a class (default for all its methods) or a method/field into retry via `RetryInterceptor`
 * (`@caffeinejs/fetchy/retry`) — a request is retried on a response status in `statusCodes`, or on a transport
 * failure whose code is in `errorCodes`, when its HTTP method is in `methods`, per `options` (unset
 * fields fall back to `DEFAULT_RETRY_OPTIONS`). A request whose body can be read only once, such as
 * a stream, is never retried. A method-level `@Retry()` completely replaces an inherited class-level
 * one — options are not merged across levels.
 *
 * `retryAfterHeader` defaults to `retry-after`. Its value (seconds or an HTTP date) extends `delay`
 * when needed. Missing or malformed values use `delay`. A server wait exceeding `maxRetryAfter`
 * ends retries with the current response.
 * @throws {@link ErrFetchyInvalidRetryOptions} if `retryAfterHeader` is not a valid HTTP header name.
 */
export function Retry(options: Partial<RetryOptions> = {}) {
  const resolved: RetryOptions = {
    ...DEFAULT_RETRY_OPTIONS,
    ...options,
    retryAfterHeader: options.retryAfterHeader ?? DEFAULT_RETRY_OPTIONS.retryAfterHeader,
  }

  // Validate at declaration, before a request could leave an unread response behind.
  if (!HEADER_NAME.test(resolved.retryAfterHeader)) {
    throw new ErrFetchyInvalidRetryOptions(
      `retryAfterHeader ${JSON.stringify(resolved.retryAfterHeader)} is not a valid header name`,
      'Set retryAfterHeader to a header name of letters, digits and "-", such as "retry-after"',
    )
  }

  return classOrMember(
    'Retry',
    (_target, context) => configureClass(context, spec => spec.retry(resolved)),
    context => configureMethod(context, spec => spec.retry(resolved)),
  )
}

/**
 * Cancels an inherited class-level `@Retry()` for this method (or field-declared operation).
 */
export function NoRetry() {
  return function (_value: unknown, context: ClassMethodDecoratorContext | ClassFieldDecoratorContext): void {
    if ((context.kind !== 'method' && context.kind !== 'field') || context.static) {
      throw new ErrFetchyInvalidDecoratorTarget('NoRetry', 'an instance method or field')
    }

    configureMethod(context, spec => spec.noRetry(true))
  }
}

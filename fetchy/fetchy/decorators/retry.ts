import { DEFAULT_RETRY_OPTIONS, type RetryOptions } from '../retry_options.js'
import { classOrMember } from './_decorator_util.js'
import { configureClass, configureMethod } from './registrar/registrar.js'

/**
 * Opts a class (default for all its methods) or a method/field into retry via `RetryInterceptor`
 * (`builtin/retry`) — a request is retried on a response status in `statusCodes`, or on a transport
 * failure whose code is in `errorCodes`, when its HTTP method is in `methods`, per `options` (unset
 * fields fall back to `DEFAULT_RETRY_OPTIONS`). A method-level `@Retry()` completely replaces an
 * inherited class-level one — options are not merged across levels.
 */
export function Retry(options: Partial<RetryOptions> = {}) {
  const resolved: RetryOptions = { ...DEFAULT_RETRY_OPTIONS, ...options }

  return classOrMember(
    'Retry',
    (_target, context) => configureClass(context, spec => spec.retry(resolved)),
    context => configureMethod(context, spec => spec.retry(resolved)),
  )
}

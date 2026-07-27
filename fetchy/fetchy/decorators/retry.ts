import { DEFAULT_RETRY_OPTIONS, type RetryOptions } from '../retry_options.js'
import { classOrMember } from './_decorator_util.js'
import { configureClass, configureMethod } from './registrar/registrar.js'

/**
 * Opts a class (default for all its methods) or a method/field into retry via `RetryInterceptor`
 * (`builtin/retry`) — retried requests are gated by response status code and HTTP method, per
 * `options` (unset fields fall back to `DEFAULT_RETRY_OPTIONS`). A method-level `@Retry()`
 * completely replaces an inherited class-level one — options are not merged across levels.
 */
export function Retry(options: Partial<RetryOptions> = {}) {
  const resolved: RetryOptions = { ...DEFAULT_RETRY_OPTIONS, ...options }

  return classOrMember(
    'Retry',
    (_target, context) => configureClass(context, spec => spec.retry(resolved)),
    context => configureMethod(context, spec => spec.retry(resolved)),
  )
}

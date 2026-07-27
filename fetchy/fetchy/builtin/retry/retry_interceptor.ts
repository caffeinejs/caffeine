import type { Chain } from '../../chain.js'
import type { Interceptor } from '../../interceptor.js'
import { sleep } from '../../internal/sleep.js'
import type { RetryOptions } from '../../retry_options.js'

/**
 * Retries a request when the response is a non-ok status included in the effective
 * `RetryOptions.statusCodes`, for a request method included in `RetryOptions.methods` — driven
 * entirely by `@Retry()`/`@NoRetry()` decorator metadata (`chain.meta()`), read fresh on every
 * call. A method with neither decorator is a pure passthrough (single attempt).
 *
 * Not registered by default — add via `FetchyBuilder.addInterceptor(RetryInterceptor.INSTANCE)`.
 * Because the retry loop lives entirely inside one `intercept()` call, any interceptor registered
 * *after* this one (via `.addInterceptor()`) observes every individual attempt; one registered
 * *before* it only sees the single overall outcome.
 */
export class RetryInterceptor implements Interceptor {
  static readonly INSTANCE = new RetryInterceptor()

  async intercept(chain: Chain): Promise<Response> {
    const meta = chain.meta()

    if (meta.noRetry || !meta.retry) {
      return chain.proceed(chain.request())
    }

    return this.attempt(chain, meta.retry, 1)
  }

  private async attempt(chain: Chain, options: RetryOptions, current: number): Promise<Response> {
    const pristine = chain.request()
    const response = await chain.proceed(pristine.clone())

    if (current >= options.limit || !this.isRetryable(response, pristine, options)) {
      return response
    }

    if (!response.bodyUsed) {
      await response.body?.cancel()
    }

    await sleep(options.delay, pristine.signal)

    return this.attempt(chain, options, current + 1)
  }

  private isRetryable(response: Response, request: Request, options: RetryOptions): boolean {
    return !response.ok && options.statusCodes.includes(response.status) && options.methods.includes(request.method)
  }
}

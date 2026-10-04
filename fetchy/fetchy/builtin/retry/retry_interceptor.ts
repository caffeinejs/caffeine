import type { Chain } from '../../chain.js'
import type { Interceptor } from '../../interceptor.js'
import { sleep } from '../../internal/sleep.js'
import type { FetchyRequest } from '../../request.js'
import type { FetchyResponse } from '../../response.js'
import type { RetryOptions } from '../../retry_options.js'

// `fetch` rejects with a `TypeError` whose `cause` is the network error; undici's own API rejects with that error.
function errorCode(error: unknown): string | undefined {
  const failure = error as { code?: unknown; cause?: { code?: unknown } } | null | undefined
  const code = failure?.code ?? failure?.cause?.code

  return typeof code === 'string' ? code : undefined
}

// Every attempt sends the same body, so only a body that survives being sent is retried. Anything not listed is taken
// for a stream or an iterator, which the first attempt may have read.
function isReplayable(body: FetchyRequest['body']): boolean {
  return (
    body === null ||
    body === undefined ||
    typeof body === 'string' ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    body instanceof Blob ||
    body instanceof URLSearchParams ||
    body instanceof FormData
  )
}

/**
 * Retries a request when the response is a non-ok status included in the effective
 * `RetryOptions.statusCodes`, or when the transport fails with an error whose code is in
 * `RetryOptions.errorCodes`, for a request method included in `RetryOptions.methods` — driven
 * entirely by `@Retry()`/`@NoRetry()` decorator metadata (`chain.meta()`), read fresh on every
 * call. A method with neither decorator is a pure passthrough (single attempt). A request whose
 * signal is aborted is never retried. Neither is one whose body can be read only once, such as a
 * stream: every attempt sends the same body, and the first may have read it.
 *
 * Not registered by default — add via `FetchyBuilder.addInterceptor(RetryInterceptor.INSTANCE)`.
 * Because the retry loop lives entirely inside one `intercept()` call, any interceptor registered
 * *after* this one (via `.addInterceptor()`) observes every individual attempt; one registered
 * *before* it only sees the single overall outcome.
 */
export class RetryInterceptor implements Interceptor {
  static readonly INSTANCE = new RetryInterceptor()

  async intercept(chain: Chain): Promise<FetchyResponse> {
    const meta = chain.meta()

    if (meta.noRetry || !meta.retry) {
      return chain.proceed(chain.request())
    }

    return this.attempt(chain, meta.retry, 1)
  }

  private async attempt(chain: Chain, options: RetryOptions, current: number): Promise<FetchyResponse> {
    const pristine = chain.request()
    let response: FetchyResponse

    try {
      response = await chain.proceed(pristine.clone())
    } catch (error) {
      if (current >= options.limit || !this.isRetryableFailure(error, pristine, options)) {
        throw error
      }

      await sleep(options.delay, pristine.signal)

      return this.attempt(chain, options, current + 1)
    }

    if (current >= options.limit || !this.isRetryable(response, pristine, options)) {
      return response
    }

    if (!response.bodyUsed) {
      await response.body?.cancel()
    }

    await sleep(options.delay, pristine.signal)

    return this.attempt(chain, options, current + 1)
  }

  private isRetryable(response: FetchyResponse, request: FetchyRequest, options: RetryOptions): boolean {
    return (
      !response.ok &&
      options.statusCodes.includes(response.status) &&
      options.methods.includes(request.method) &&
      isReplayable(request.body)
    )
  }

  private isRetryableFailure(error: unknown, request: FetchyRequest, options: RetryOptions): boolean {
    if (request.signal?.aborted || !options.methods.includes(request.method) || !isReplayable(request.body)) {
      return false
    }

    const code = errorCode(error)

    return code !== undefined && options.errorCodes.includes(code)
  }
}

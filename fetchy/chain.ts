import type { Interceptor } from './interceptor.js'

/**
 * Linked-list interceptor chain: each interceptor decides whether to call
 * `chain.proceed(request)` to continue to the next interceptor (and, eventually, the actual
 * network call), possibly after inspecting/mutating the request or the resulting response.
 */
export interface Chain {
  request(): Request

  proceed(request: Request): Promise<Response>
}

export class ChainExecutor implements Chain {
  private constructor(
    private readonly interceptors: readonly Interceptor[],
    private readonly index: number,
    private readonly currentRequest: Request,
  ) {}

  static first(interceptors: readonly Interceptor[], request: Request): ChainExecutor {
    return new ChainExecutor(interceptors, 0, request)
  }

  request(): Request {
    return this.currentRequest
  }

  proceed(request: Request): Promise<Response> {
    const next = new ChainExecutor(this.interceptors, this.index + 1, request)
    return this.interceptors[this.index].intercept(next)
  }
}

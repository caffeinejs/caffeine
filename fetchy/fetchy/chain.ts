import type { MethodSpec } from './decorators/registrar/index.js'
import type { Interceptor } from './interceptor.js'

/**
 * Linked-list interceptor chain: each interceptor decides whether to call
 * `chain.proceed(request)` to continue to the next interceptor (and, eventually, the actual
 * network call), possibly after inspecting/mutating the request or the resulting response.
 */
export interface Chain {
  request(): Request

  proceed(request: Request): Promise<Response>

  meta(): MethodSpec
}

export class ChainExecutor implements Chain {
  private constructor(
    private readonly interceptors: readonly Interceptor[],
    private readonly index: number,
    private readonly currentRequest: Request,
    private readonly requestMeta: MethodSpec,
  ) {}

  static first(interceptors: readonly Interceptor[], request: Request, meta: MethodSpec): ChainExecutor {
    return new ChainExecutor(interceptors, 0, request, meta)
  }

  request(): Request {
    return this.currentRequest
  }

  meta(): MethodSpec {
    return this.requestMeta
  }

  proceed(request: Request): Promise<Response> {
    const next = new ChainExecutor(this.interceptors, this.index + 1, request, this.requestMeta)
    return this.interceptors[this.index].intercept(next)
  }
}

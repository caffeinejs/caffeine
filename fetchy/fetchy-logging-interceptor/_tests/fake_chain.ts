import type { Chain, MethodSpec } from '@caffeinejs/fetchy'

const DEFAULT_META: MethodSpec = {
  httpMethod: '',
  path: '',
  headers: new Headers(),
  params: [],
  formURLEncoded: false,
  requestType: undefined,
  responseConverter: undefined,
  requestBodyConverter: undefined,
  responseHandler: undefined,
  kind: 'method',
  callback: false,
  retry: undefined,
  noRetry: false,
}

/**
 * Minimal fake {@link Chain} for unit-testing an interceptor's `intercept()` in isolation,
 * without a real network call or client pipeline. `meta()` returns a fixed default — this
 * package's own interceptor never reads it, it only exists to satisfy the `Chain` interface.
 */
export function fakeChain(request: Request, respond: () => Promise<Response>): Chain {
  return {
    request: () => request,
    proceed: () => respond(),
    meta: () => DEFAULT_META,
  }
}

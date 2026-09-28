import type { Chain } from './chain.js'
import type { FetchyResponse } from './response.js'

export interface Interceptor {
  intercept(chain: Chain): Promise<FetchyResponse>
}

export type InterceptorFunction = (chain: Chain) => Promise<FetchyResponse>

export function toInterceptor(value: Interceptor | InterceptorFunction): Interceptor {
  return typeof value === 'function' ? { intercept: value } : value
}

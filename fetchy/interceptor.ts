import type { Chain } from './chain.js'

export interface Interceptor {
  intercept(chain: Chain): Promise<Response>
}

export type InterceptorFunction = (chain: Chain) => Promise<Response>

export function toInterceptor(value: Interceptor | InterceptorFunction): Interceptor {
  return typeof value === 'function' ? { intercept: value } : value
}

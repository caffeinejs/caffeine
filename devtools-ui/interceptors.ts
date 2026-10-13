import type { InterceptorFunction } from '@caffeinejs/fetchy'

import type { ApplicationConfig } from './config.js'

/** Bounds each call with a deadline of its own, so one slow call never shortens the next. */
export function timeout(ms: number): InterceptorFunction {
  return chain => {
    const request = chain.request()
    request.signal = AbortSignal.timeout(ms)
    return chain.proceed(request)
  }
}

/** Sends the same headers on every call: an application's credentials and the static headers it declares. */
export function headers(values: Readonly<Record<string, string>>): InterceptorFunction {
  const entries = Object.entries(values)

  return chain => {
    const request = chain.request()

    for (const [name, value] of entries) {
      request.headers.set(name, value)
    }

    return chain.proceed(request)
  }
}

/** The headers an application's configuration asks for: its credentials, then its static headers. */
export function headersOf(application: ApplicationConfig): Record<string, string> {
  const values: Record<string, string> = {}
  const { basic, bearer } = application.auth ?? {}

  if (basic !== undefined) {
    values.authorization = `Basic ${Buffer.from(`${basic.username}:${basic.password}`, 'utf8').toString('base64')}`
  }

  if (bearer !== undefined) {
    values.authorization = `Bearer ${bearer}`
  }

  return { ...values, ...application.headers }
}

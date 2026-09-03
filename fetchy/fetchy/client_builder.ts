import { FetchCallFactory } from './builtin/fetch/index.js'
import type { CallFactory } from './call.js'
import type { CallAdapterFactory } from './call_adapter.js'
import { FetchyClient } from './client.js'
import type { Interceptor, InterceptorFunction } from './interceptor.js'
import { toInterceptor } from './interceptor.js'
import type { ResponseConverter } from './response_converter.js'

/**
 * Fluent builder for a {@link FetchyClient}. Defaults to a native `fetch()`-based transport when
 * `.callFactory()` is never called.
 */
export class FetchyBuilder {
  private _baseURL = ''
  private _callFactory: CallFactory | undefined
  private readonly _interceptors: Interceptor[] = []
  private readonly _callAdapterFactories: CallAdapterFactory[] = []
  private _responseConverter: ResponseConverter | undefined

  baseURL(url: string): this {
    this._baseURL = url.endsWith('/') ? url.slice(0, -1) : url
    return this
  }

  callFactory(factory: CallFactory): this {
    this._callFactory = factory
    return this
  }

  addInterceptor(interceptor: Interceptor | InterceptorFunction): this {
    this._interceptors.push(toInterceptor(interceptor))
    return this
  }

  addCallAdapterFactory(factory: CallAdapterFactory): this {
    this._callAdapterFactories.push(factory)
    return this
  }

  responseConverter(converter: ResponseConverter): this {
    this._responseConverter = converter
    return this
  }

  build(): FetchyClient {
    return new FetchyClient({
      baseURL: this._baseURL,
      callFactory: this._callFactory ?? new FetchCallFactory(),
      interceptors: this._interceptors,
      callAdapterFactories: this._callAdapterFactories,
      responseConverter: this._responseConverter,
    })
  }
}

export function newClient(): FetchyBuilder {
  return new FetchyBuilder()
}

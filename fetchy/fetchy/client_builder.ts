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
  #baseURL = ''
  #callFactory: CallFactory | undefined
  readonly #interceptors: Interceptor[] = []
  readonly #callAdapterFactories: CallAdapterFactory[] = []
  #responseConverter: ResponseConverter | undefined

  baseURL(url: string): this {
    this.#baseURL = url.endsWith('/') ? url.slice(0, -1) : url
    return this
  }

  callFactory(factory: CallFactory): this {
    this.#callFactory = factory
    return this
  }

  addInterceptor(interceptor: Interceptor | InterceptorFunction): this {
    this.#interceptors.push(toInterceptor(interceptor))
    return this
  }

  addCallAdapterFactory(factory: CallAdapterFactory): this {
    this.#callAdapterFactories.push(factory)
    return this
  }

  responseConverter(converter: ResponseConverter): this {
    this.#responseConverter = converter
    return this
  }

  build(): FetchyClient {
    return new FetchyClient({
      baseURL: this.#baseURL,
      callFactory: this.#callFactory ?? new FetchCallFactory(),
      interceptors: this.#interceptors,
      callAdapterFactories: this.#callAdapterFactories,
      responseConverter: this.#responseConverter,
    })
  }
}

export function newClient(): FetchyBuilder {
  return new FetchyBuilder()
}

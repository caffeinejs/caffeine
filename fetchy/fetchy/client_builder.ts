import { FetchTransportFactory } from './builtin/fetch/index.js'
import type { CallAdapterFactory } from './call_adapter.js'
import { FetchyClient } from './client.js'
import type { Interceptor, InterceptorFunction } from './interceptor.js'
import { toInterceptor } from './interceptor.js'
import type { ResponseConverter } from './response_converter.js'
import type { TransportFactory } from './transport.js'

/**
 * Fluent builder for a {@link FetchyClient}. Defaults to a native `fetch()`-based transport when
 * `.transportFactory()` is never called.
 */
export class FetchyBuilder {
  #baseURL = ''
  #transportFactory: TransportFactory | undefined
  readonly #interceptors: Interceptor[] = []
  readonly #callAdapterFactories: CallAdapterFactory[] = []
  #responseConverter: ResponseConverter | undefined

  baseURL(url: string): this {
    this.#baseURL = url.endsWith('/') ? url.slice(0, -1) : url
    return this
  }

  transportFactory(factory: TransportFactory): this {
    this.#transportFactory = factory
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
      transportFactory: this.#transportFactory ?? new FetchTransportFactory(),
      interceptors: this.#interceptors,
      callAdapterFactories: this.#callAdapterFactories,
      responseConverter: this.#responseConverter,
    })
  }
}

export function newClient(): FetchyBuilder {
  return new FetchyBuilder()
}

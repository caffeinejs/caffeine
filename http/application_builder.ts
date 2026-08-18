import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  BaseApplicationBuilder,
  type ApplicationBuilderOptions,
  type Augment,
  type Plugin,
  installPlugins,
} from '@caffeinejs/std'
import { AdapterFactory, WebApplication, type Adapter } from './application.js'
import { FastifyAdapter } from './adapter.js'
import { fastifyAdapterFactory } from './adapter_factory.js'
import { AuthenticationBuilder } from './security/auth/builder.js'
import { AuthorizationBuilder } from './security/authz/index.js'
import { CacheBuilder } from './cache/cache_builder.js'
import { ServerBuilder } from './server/index.js'
import { StaticBuilder } from './static/index.js'

export type WebApplicationBuilderOptions = ApplicationBuilderOptions

export class WebApplicationBuilder<I, REQ, A extends Adapter<I, REQ> = Adapter<I, REQ>>
  extends BaseApplicationBuilder<WebApplication<I, REQ, A>> {
  readonly #adapterFactory: AdapterFactory<I, REQ, A>

  #authBuilder: AuthenticationBuilder | undefined
  #cacheBuilder: CacheBuilder | undefined
  #serverBuilder: ServerBuilder | undefined
  #staticBuilder: StaticBuilder | undefined
  readonly #authzBuilder: AuthorizationBuilder

  constructor(adapterFactory: AdapterFactory<I, REQ, A>, options: WebApplicationBuilderOptions = {}) {
    super(options)
    this.#adapterFactory = adapterFactory

    this.#authzBuilder = new AuthorizationBuilder()
    this.addService(this.#authzBuilder)
  }

  authentication(configure: (auth: AuthenticationBuilder) => void): this {
    if (this.#authBuilder == null) {
      this.#authBuilder = new AuthenticationBuilder()
      this.addService(this.#authBuilder)
    }

    configure(this.#authBuilder)

    return this
  }

  authorization(configure: (authz: AuthorizationBuilder) => void): this {
    configure(this.#authzBuilder)
    return this
  }

  cache(configure: (cache: CacheBuilder) => void): this {
    if (this.#cacheBuilder == null) {
      this.#cacheBuilder = new CacheBuilder()
      this.addService(this.#cacheBuilder)
    }

    configure(this.#cacheBuilder)

    return this
  }

  server(configure: (server: ServerBuilder) => void): this {
    if (this.#serverBuilder == null) {
      this.#serverBuilder = new ServerBuilder()
      this.addService(this.#serverBuilder)
    }

    configure(this.#serverBuilder)

    return this
  }

  static(configure: (staticFiles: StaticBuilder) => void): this {
    if (this.#staticBuilder == null) {
      this.#staticBuilder = new StaticBuilder()
      this.addService(this.#staticBuilder)
    }

    configure(this.#staticBuilder)

    return this
  }

  build(): WebApplication<I, REQ, A> {
    const adapter = this.#adapterFactory({ container: this.container })
    return new WebApplication<I, REQ, A>(this.applicationInit(), adapter)
  }
}

// Default Fastify — no adapter factory or Fastify instance required.
export function createWebApplication<const S extends readonly Plugin[] = readonly []>(
  options?: WebApplicationBuilderOptions,
  ...plugins: S
): WebApplicationBuilder<FastifyInstance, FastifyRequest, FastifyAdapter<FastifyInstance, FastifyRequest>> & Augment<S>
// Explicit adapter factory — a customized Fastify instance (`fastifyAdapterFactory(myFastify)`) or a
// custom adapter altogether.
export function createWebApplication<
  I,
  REQ,
  A extends Adapter<I, REQ> = Adapter<I, REQ>,
  const S extends readonly Plugin[] = readonly [],
>(
  adapterFactory: AdapterFactory<I, REQ, A>,
  options?: WebApplicationBuilderOptions,
  ...plugins: S
): WebApplicationBuilder<I, REQ, A> & Augment<S>
export function createWebApplication(
  first?: AdapterFactory<any, any> | WebApplicationBuilderOptions,
  ...rest: unknown[]
): WebApplicationBuilder<any, any> {
  let adapterFactory: AdapterFactory<any, any>
  let options: WebApplicationBuilderOptions
  let plugins: Plugin[]

  if (typeof first === 'function') {
    adapterFactory = first
    options = (rest[0] as WebApplicationBuilderOptions | undefined) ?? {}
    plugins = rest.slice(1) as Plugin[]
  } else {
    adapterFactory = fastifyAdapterFactory()
    options = first ?? {}
    plugins = rest as Plugin[]
  }

  const builder = new WebApplicationBuilder(adapterFactory, options)
  installPlugins(builder, plugins)

  return builder
}

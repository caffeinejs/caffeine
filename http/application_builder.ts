import { CaffeineIoC, type Container, type Module, type Options } from '@caffeinejs/di'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { AdapterFactory, WebApplication, type Adapter } from './application.js'
import { FastifyAdapter } from './adapter.js'
import { fastifyAdapterFactory } from './adapter_factory.js'
import { Augment, BuilderPlugin, BuilderPluginContext } from './plugin.js'
import { AuthenticationBuilder } from './security/auth/builder.js'
import { AuthorizationBuilder } from './security/authz/index.js'
import { CacheBuilder } from './cache/cache_builder.js'
import { ServerBuilder } from './server/index.js'
import { Service } from './service.js'

export type WebApplicationBuilderOptions = {
  container?: Container | Options
}

export class WebApplicationBuilder<I, REQ, A extends Adapter<I, REQ> = Adapter<I, REQ>> {
  readonly #adapterFactory: AdapterFactory<I, REQ, A>
  readonly #container: Container
  readonly #services: Service[] = []

  #authBuilder: AuthenticationBuilder | undefined
  #cacheBuilder: CacheBuilder | undefined
  #serverBuilder: ServerBuilder | undefined
  readonly #authzBuilder: AuthorizationBuilder

  constructor(adapterFactory: AdapterFactory<I, REQ, A>, options: WebApplicationBuilderOptions = {}) {
    const c = options.container
    this.#container = c != null && typeof (c as Container).get === 'function'
      ? c as Container
      : new CaffeineIoC(c != null ? c as Partial<Options> : {})
    this.#adapterFactory = adapterFactory

    this.#authzBuilder = new AuthorizationBuilder()
    this.#services.push(this.#authzBuilder)
  }

  get container(): Container {
    return this.#container
  }

  authentication(configure: (auth: AuthenticationBuilder) => void): this {
    if (this.#authBuilder == null) {
      this.#authBuilder = new AuthenticationBuilder()
      this.#services.push(this.#authBuilder)
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
      this.#services.push(this.#cacheBuilder)
    }

    configure(this.#cacheBuilder)

    return this
  }

  server(configure: (server: ServerBuilder) => void): this {
    if (this.#serverBuilder == null) {
      this.#serverBuilder = new ServerBuilder()
      this.#services.push(this.#serverBuilder)
    }

    configure(this.#serverBuilder)

    return this
  }

  addService(service: Service): this {
    this.#services.push(service)
    return this
  }

  addModules(module: Module, ...modules: Module[]): this {
    this.#container.addModules(module, ...modules)
    return this
  }

  build(): WebApplication<I, REQ, A> {
    const adapter = this.#adapterFactory({ container: this.#container })
    return new WebApplication<I, REQ, A>(this.#container, adapter, this.#services)
  }
}

// Default Fastify — no adapter factory or Fastify instance required.
export function createWebApplication<const S extends readonly BuilderPlugin[] = readonly []>(
  options?: WebApplicationBuilderOptions,
  ...plugins: S
): WebApplicationBuilder<FastifyInstance, FastifyRequest, FastifyAdapter<FastifyInstance, FastifyRequest>> & Augment<S>
// Explicit adapter factory — a customized Fastify instance (`fastifyAdapterFactory(myFastify)`) or a
// custom adapter altogether.
export function createWebApplication<
  I,
  REQ,
  A extends Adapter<I, REQ> = Adapter<I, REQ>,
  const S extends readonly BuilderPlugin[] = readonly [],
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
  let plugins: BuilderPlugin[]

  if (typeof first === 'function') {
    adapterFactory = first
    options = (rest[0] as WebApplicationBuilderOptions | undefined) ?? {}
    plugins = rest.slice(1) as BuilderPlugin[]
  } else {
    adapterFactory = fastifyAdapterFactory()
    options = first ?? {}
    plugins = rest as BuilderPlugin[]
  }

  const builder = new WebApplicationBuilder(adapterFactory, options)
  const ctx: BuilderPluginContext = {
    addService: service => { builder.addService(service) },
    container: builder.container,
  }

  for (const plugin of plugins) {
    Object.assign(builder, plugin.install(ctx))
  }

  return builder
}

import { CaffeineIoC, type Container, type Module, type Options } from '@caffeinejs/di'
import { AdapterFactory, WebApplication, type Adapter } from './application.js'
import { Augment, BuilderPlugin, BuilderPluginContext } from './plugin.js'
import { AuthenticationBuilder } from './security/auth/builder.js'
import { AuthorizationBuilder } from './security/authz/index.js'
import { CacheBuilder } from './cache/cache_builder.js'
import { Service } from './service.js'

export type WebApplicationOptions = {
  container?: Container | Options
}

export class WebApplicationBuilder<I, REQ, A extends Adapter<I, REQ> = Adapter<I, REQ>> {
  readonly #adapterFactory: AdapterFactory<I, REQ, A>
  readonly #container: Container
  readonly #services: Service[] = []

  #authBuilder: AuthenticationBuilder | undefined
  #cacheBuilder: CacheBuilder | undefined
  readonly #authzBuilder: AuthorizationBuilder

  constructor(adapterFactory: AdapterFactory<I, REQ, A>, options: WebApplicationOptions = {}) {
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

export function createWebApplication<
  I,
  REQ,
  A extends Adapter<I, REQ> = Adapter<I, REQ>,
  const S extends readonly BuilderPlugin[] = readonly [],
>(
  adapterFactory: AdapterFactory<I, REQ, A>,
  options: WebApplicationOptions = {},
  ...plugins: S
): WebApplicationBuilder<I, REQ, A> & Augment<S> {
  const builder = new WebApplicationBuilder(adapterFactory, options)
  const ctx: BuilderPluginContext = {
    addService: service => { builder.addService(service) },
    container: builder.container,
  }

  for (const plugin of plugins) {
    Object.assign(builder, plugin.install(ctx))
  }

  return builder as WebApplicationBuilder<I, REQ, A> & Augment<S>
}

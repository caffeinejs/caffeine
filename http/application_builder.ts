import { CaffeineIoC, type Container, type Module, type Options } from '@caffeinejs/di'
import { AdapterFactory, WebApplication, type Adapter } from './application.js'
import { Augment, BuilderPlugin, BuilderPluginContext } from './plugin.js'
import { AuthenticationBuilder } from './security/auth/builder.js'
import { AuthorizationBuilder } from './security/authz/index.js'
import { Service } from './service.js'

export type WebApplicationOptions = {
  container?: Container | Options
}

export class WebApplicationBuilder<I, REQ, A extends Adapter<I, REQ> = Adapter<I, REQ>> {
  readonly #adapterFactory: AdapterFactory<I, REQ, A>
  readonly #container: Container
  readonly #services: Service[] = []

  #authBuilder: AuthenticationBuilder | undefined
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

  get authentication(): AuthenticationBuilder {
    if (this.#authBuilder == null) {
      this.#authBuilder = new AuthenticationBuilder()
      this.#services.push(this.#authBuilder)
    }

    return this.#authBuilder
  }

  get authorization(): AuthorizationBuilder {
    return this.#authzBuilder
  }

  get container(): Container {
    return this.#container
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
    return new WebApplication(this.#container, this.#adapterFactory({ container: this.#container }), this.#services)
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

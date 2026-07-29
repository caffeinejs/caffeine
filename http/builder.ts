import { CaffeineIoC, type Container, type Module, type Options } from '@caffeinejs/di'
import { AdapterFactory, WebApplication, type Adapter } from './application.js'
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
  #authzBuilder: AuthorizationBuilder | undefined

  constructor(adapterFactory: AdapterFactory<I, REQ, A>, options: WebApplicationOptions = {}) {
    const c = options.container
    this.#container = c != null && typeof (c as Container).get === 'function'
      ? c as Container
      : new CaffeineIoC(c != null ? c as Partial<Options> : {})
    this.#adapterFactory = adapterFactory
  }

  get authentication(): AuthenticationBuilder {
    if (this.#authBuilder == null) {
      this.#authBuilder = new AuthenticationBuilder()
      this.#services.push(this.#authBuilder)
    }

    return this.#authBuilder
  }

  get authorization(): AuthorizationBuilder {
    if (this.#authzBuilder == null) {
      this.#authzBuilder = new AuthorizationBuilder()
      this.#services.push(this.#authzBuilder)
    }

    return this.#authzBuilder
  }

  addModules(module: Module, ...modules: Module[]): this {
    this.#container.addModules(module, ...modules)
    return this
  }

  build(): WebApplication<I, REQ, A> {
    return new WebApplication(this.#container, this.#adapterFactory({ container: this.#container }), this.#services)
  }
}

export function createWebApplication<I, REQ, A extends Adapter<I, REQ> = Adapter<I, REQ>>(
  adapterFactory: AdapterFactory<I, REQ, A>,
  options: WebApplicationOptions = {},
): WebApplicationBuilder<I, REQ, A> {
  return new WebApplicationBuilder(adapterFactory, options)
}

import { CaffeineIoC, Container, Module, Options } from '@caffeinejs/core'
import { Adapter, AdapterFactory, WebApplication } from './application.js'
import { CaffeineError } from './error.js'
import { getRouter } from './decorators/registrar/registrar.js'
import { Router } from './route.js'
import { Keys } from './symbols.js'

export type WebApplicationOptions = {
  container?: Container | Options
}

export class WebApplicationBuilder<I, REQ, A extends Adapter<I, REQ> = Adapter<I, REQ>> {
  readonly #adapterFactory: AdapterFactory<I, REQ, A>
  readonly #container: Container

  constructor(adapterFactory: AdapterFactory<I, REQ, A>, options: WebApplicationOptions = {}) {
    const c = options.container
    this.#container = c != null && typeof (c as Container).get === 'function'
      ? c as Container
      : new CaffeineIoC(c != null ? c as Partial<Options> : {})
    this.#adapterFactory = adapterFactory
  }

  addModules(module: Module, ...modules: Module[]): this {
    this.#container.addModules(module, ...modules)
    return this
  }

  build(): WebApplication<I, REQ, A> {
    const container = this.#container
    const adapter = this.#adapterFactory({ container })
    const controllers = container.getBindingsByLabel(Keys.CONTROLLER)
    const routers = new Array<Router<REQ>>(controllers.length)

    for (let i = 0; i < controllers.length; i++) {
      const { key, binding } = controllers[i]
      const rd = getRouter(key as Function)
      if (!rd) {
        throw new CaffeineError(
          `Cannot build router: no route definition found for router "${String(key)}"`,
          'HTTP_MISSING_ROUTER',
        )
      }
      routers[i] = rd.toRouter<REQ>(key, binding, container.wrap(key))
    }

    return new WebApplication(container, routers, adapter)
  }
}

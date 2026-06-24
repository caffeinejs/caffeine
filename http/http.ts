import { Container, DiCaf, Module, Options } from '@caffeinejs/core'
import { Keys } from './symbols.js'
import { Router, RouteValidationSchema } from './route.js'
import { Adapter, AdapterFactory } from './adapter.js'
import { getRouter } from './decorators/_registrar.js'
import { CaffeineError } from './error.js'

export type CaffeineHTTPOptions = {
  container?: Container | Options
}

export class CaffeineHTTP<I, REQ, A extends Adapter<I, REQ> = Adapter<I, REQ>> {
  #container: Container
  #modules: Module[] = []
  #adapterFactory: AdapterFactory<I, REQ, A>

  constructor(
    adapterFactory: AdapterFactory<I, REQ, A>,
    options: CaffeineHTTPOptions = {},
  ) {
    this.#adapterFactory = adapterFactory
    this.#container = typeof options.container === 'function'
      ? options.container
      : new DiCaf(typeof options.container === 'object' ? options.container as Partial<Options> : {})
  }

  modules(...modules: Module[]): this {
    this.#modules.push(...modules)
    return this
  }

  async create(): Promise<A> {
    const controllers = this.#container.getBindingsByLabel(Keys.CONTROLLER)
    const routers = new Array<Router<REQ, RouteValidationSchema>>(controllers.length)

    for (let i = 0; i < controllers.length; i++) {
      const { key, binding } = controllers[i]
      const rd = getRouter(key as Function)
      if (!rd) {
        throw new CaffeineError(`Cannot build router: no route definition found for controller "${String(key)}"`, 'HTTP_MISSING_ROUTER')
      }
      routers[i] = rd.toRouter<REQ, RouteValidationSchema>(key, binding, this.#container.wrap(key))
    }

    return this.#adapterFactory({ container: this.#container }, { routers })
  }
}

export function newHTTP<I, REQ, A extends Adapter<I, REQ> = Adapter<I, REQ>>(
  adapterFactory: AdapterFactory<I, REQ, A>,
  options: CaffeineHTTPOptions = {},
): CaffeineHTTP<I, REQ, A> {
  return new CaffeineHTTP(adapterFactory, options)
}

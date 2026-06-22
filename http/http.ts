import { Container, DiCaf, Module, Options } from '@caffeine/core'
import { Keys } from './symbols.js'
import { Router } from './route.js'
import { Adaptee, AdapterFactory } from './adapter.js'
import { getRouter } from './decorators/_registrar.js'

export type HTTPApplicationOptions = {
  container?: Container | Options
}

export class CaffeineHTTP<REQ, A> {
  #container: Container
  #modules!: Module[]

  constructor(
    private readonly adapterFactory: AdapterFactory<REQ, A>,
    options: HTTPApplicationOptions = {},
  ) {
    this.#container = typeof options.container === 'function'
      ? options.container
      : new DiCaf(typeof options.container === 'object' ? options.container as Partial<Options> : {})
  }

  use(module: Module): this {
    this.#modules ??= []
    this.#modules.push(module)
    return this
  }

  async ready(): Promise<Adaptee<A>> {
    const adapter = await Promise.resolve(this.adapterFactory({ container: this.#container }))

    return adapter({ routers: [] })
  }
}

export async function newHTTP<REQ, A>(adapterFactory: AdapterFactory<REQ, A>, options: HTTPApplicationOptions = {}): Promise<Adaptee<A>> {
  const container = typeof options.container === 'function'
    ? options.container
    : new DiCaf(typeof options.container === 'object' ? options.container as Partial<Options> : {})

  await container.init()

  const controllers = container.getBindingsByLabel(Keys.CONTROLLER)
  const routers = new Array<Router<REQ>>(controllers.length)

  for (let i = 0; i < controllers.length; i++) {
    const { key, binding } = controllers[i]
    const rd = getRouter(key as Function)
    if (!rd) {
      throw new Error(`Router definition not found for controller ${String(key)}`)
    }

    routers[i] = rd.toRouter<REQ>(key, binding, container.wrap(key))
  }

  return Promise
    .resolve(adapterFactory({ container }))
    .then(adapter => adapter({ routers }))
}

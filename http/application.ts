import { Container, Module } from '@caffeinejs/core'
import { Router } from './route.js'

export interface AdapterIn<R> {
  routers: Router<R>[]
}

export interface Adapter<I, R> {
  setup(input: AdapterIn<R>): Promise<void>
  teardown(): Promise<void>
  server(): I
  fetch(request: Request | string | URL, options?: RequestInit): Promise<Response>
}

export interface AdapterFactoryIn {
  container: Container
}

export type AdapterFactory<I, REQ, A extends Adapter<I, REQ> = Adapter<I, REQ>>
  = (kit: AdapterFactoryIn) => A

export class Application<I, R, A extends Adapter<I, R> = Adapter<I, R>> {
  #container: Container
  #routers: Router<R>[]
  #adapter: A
  #readyHooks: Array<() => Promise<void>> = []
  #closeHooks: Array<() => Promise<void>> = []

  constructor(container: Container, routers: Router<R>[], adapter: A) {
    this.#container = container
    this.#routers = routers
    this.#adapter = adapter
  }

  get container(): Container {
    return this.#container
  }

  get routers(): Router<R>[] {
    return this.#routers
  }

  server(): I {
    return this.#adapter.server()
  }

  fetch(request: Request | string | URL, options?: RequestInit): Promise<Response> {
    return this.#adapter.fetch(request, options)
  }

  addModules(module: Module, ...modules: Module[]): this {
    this.#container.addModules(module, ...modules)
    return this
  }

  async ready(): Promise<void> {
    await this.#container.init()
    await this.#adapter.setup({ routers: this.#routers })

    for (const hook of this.#readyHooks) {
      await hook()
    }
  }

  async close(): Promise<void> {
    for (const hook of this.#closeHooks) {
      await hook()
    }

    await this.#adapter.teardown()
    await this.#container.dispose()
  }

  onReady(hook: () => Promise<void>): this {
    this.#readyHooks.push(hook)
    return this
  }

  onClose(hook: () => Promise<void>): this {
    this.#closeHooks.push(hook)
    return this
  }
}

import { Container } from '@caffeinejs/core'
import { Router } from './route.js'

export interface AdapterIn<R> {
  routers: Router<R>[]
}

export abstract class Adapter<I, R> {
  #container: Container
  #readyHooks: Array<() => Promise<void>> = []
  #closeHooks: Array<() => Promise<void>> = []

  constructor(container: Container, readonly routers: Router<R>[]) {
    this.#container = container
  }

  get container(): Container {
    return this.#container
  }

  async ready(): Promise<void> {
    await this.#container.init()
    await this.setup()
    for (const hook of this.#readyHooks) {
      await hook()
    }
  }

  async close(): Promise<void> {
    for (const hook of this.#closeHooks) {
      await hook()
    }
    await this.teardown()
    await this.#container.dispose()
  }

  protected abstract setup(): Promise<void>

  protected abstract teardown(): Promise<void>

  abstract instance(): I

  onReady(hook: () => Promise<void>): this {
    this.#readyHooks.push(hook)
    return this
  }

  onClose(hook: () => Promise<void>): this {
    this.#closeHooks.push(hook)
    return this
  }
}

export interface AdapterFactoryIn {
  container: Container
}

export type AdapterFactory<I, REQ, A extends Adapter<I, REQ> = Adapter<I, REQ>>
  = (kit: AdapterFactoryIn, input: AdapterIn<REQ>) => A | Promise<A>

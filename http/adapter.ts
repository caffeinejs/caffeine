import { Container } from '@caffeinejs/core'
import { Router } from './route.js'

export interface AdapterIn<R> {
  routers: Router<R>[]
}

export abstract class Adapter<I, R> {
  #container: Container

  constructor(container: Container, protected readonly routers: Router<R>[]) {
    this.#container = container
  }

  get container(): Container {
    return this.#container
  }

  abstract ready(): Promise<void>

  abstract instance(): I
}

export interface AdapterFactoryIn {
  container: Container
}

export type AdapterFactory<I, REQ, A extends Adapter<I, REQ> = Adapter<I, REQ>>
  = (kit: AdapterFactoryIn, input: AdapterIn<REQ>) => A | Promise<A>

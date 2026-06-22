import { Container } from '@caffeine-projects/dicaf'
import { Router } from './route.js'

export type Adapter<R, A> = (input: AdapterIn<R>) => Adaptee<A> | Promise<Adaptee<A>>

export interface AdapterIn<R> {
  routers: Router<R>[]
}

export interface Adaptee<I> {
  instance(): I
}

export interface AdapterFactoryIn {
  container: Container
}

export type AdapterFactory<R, A> =
  (input: AdapterFactoryIn) => Adapter<R, A> | Promise<Adapter<R, A>>

export interface Kit<R> {
  routers: Router<R>[]
  container: Container
}

export interface AdapterV2<R, I> {
  ready(): Promise<void>
  instance(): I
}

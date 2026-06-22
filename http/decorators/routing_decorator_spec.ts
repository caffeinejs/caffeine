import { Binding, Key, Provider } from '@caffeine/core'
import { Route, Router } from '../route.js'
import { ParameterPickOptions } from '../route.picker.js'

export class RouterBuilder {
  #_prefix?: string
  #_header?: Record<string, string | string[]>
  #_consumes?: string[]
  #_produces?: string[]
  #_routes?: RouteBuilder[]

  prefix(prefix: string) {
    this.#_prefix = prefix
  }

  header(name: string, value: string | string[]) {
    this.#_header ??= {}
    this.#_header[name] = value
  }

  consumes(consumes: string | string[]) {
    this.#_consumes ??= []
    this.#_consumes.push(...(Array.isArray(consumes) ? consumes : [consumes]))
  }

  produces(produces: string | string[]) {
    this.#_produces ??= []
    this.#_produces.push(...(Array.isArray(produces) ? produces : [produces]))
  }

  routes(routes: RouteBuilder | RouteBuilder[]) {
    this.#_routes ??= []
    this.#_routes.push(...(Array.isArray(routes) ? routes : [routes]))
  }

  toRouter<R>(
    key: Key,
    binding: Binding<unknown>,
    controller: Provider<Record<string | symbol, (...args: unknown[]) => unknown>>,
  ): Router<R> {
    return {
      prefix: this.#_prefix ?? '',
      routes: (this.#_routes ?? []).map(route => route.toRoute<R>()),
      header: Object.assign({}, this.#_header ?? {}),
      accept: [...(this.#_consumes ?? [])],
      contentTypes: [...(this.#_produces ?? [])],
      key,
      binding,
      controller,
    }
  }
}

export class RouteBuilder {
  #_header?: Record<string, string | string[]>
  #_path?: string
  #_method?: string[]
  #_handler?: string | symbol
  #_parameters?: ParameterPickOptions<unknown>[]
  #_consumes?: string[]
  #_produces?: string[]

  header(name: string, value: string | string[]) {
    this.#_header ??= {}
    this.#_header[name] = value
    return this
  }

  path(path: string) {
    this.#_path = path
    return this
  }

  method(method: string | string[]): this {
    this.#_method ??= []
    this.#_method.push(...(Array.isArray(method) ? method : [method]))
    return this
  }

  handler(handler: string | symbol): this {
    this.#_handler = handler
    return this
  }

  parameters(parameters: ParameterPickOptions<unknown> | ParameterPickOptions<unknown>[]) {
    this.#_parameters ??= []
    this.#_parameters.push(...(Array.isArray(parameters) ? parameters : [parameters]))
    return this
  }

  consumes(consumes: string | string[]) {
    this.#_consumes ??= []
    this.#_consumes.push(...(Array.isArray(consumes) ? consumes : [consumes]))
    return this
  }

  produces(produces: string | string[]) {
    this.#_produces ??= []
    this.#_produces.push(...(Array.isArray(produces) ? produces : [produces]))
    return this
  }

  toRoute<R>(): Route<R> {
    return {
      path: this.#_path ?? '',
      method: [...(this.#_method ?? [])],
      accept: [...(this.#_consumes ?? [])],
      contentTypes: [...(this.#_produces ?? [])],
      parameters: [...(this.#_parameters ?? [])],
      header: Object.assign({}, this.#_header ?? {}),
      handler: this.#_handler ?? '',
      response: { status: 200, header: {} },
    }
  }
}

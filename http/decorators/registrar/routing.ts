import { Binding, Key, Provider } from '@caffeinejs/core'
import { Route, Router, RouteValidationSchema } from '../../route.js'
import { ParameterPickOptions } from '../../route.picker.js'

export class RouterBuilder {
  _path?: string
  #_prefix?: string
  #_header?: Map<string, string | string[]>
  #_consumes?: string[]
  #_produces: string = ''
  #_routes?: RouteBuilder[]
  #_bodyLimit?: number
  #_timeout?: number

  path(path: string) {
    this._path = path
    return this
  }

  header(name: string, value: string | string[]) {
    this.#_header ??= new Map()
    this.#_header.set(name, value)
    return this
  }

  consumes(consumes: string | string[]) {
    this.#_consumes ??= []
    this.#_consumes.push(...(Array.isArray(consumes) ? consumes : [consumes]))
    return this
  }

  produces(produces: string) {
    this.#_produces = produces
    return this
  }

  routes(routes: RouteBuilder | RouteBuilder[]) {
    this.#_routes ??= []
    this.#_routes.push(...(Array.isArray(routes) ? routes : [routes]))
    return this
  }

  prefix(prefix: string) {
    this.#_prefix = prefix
    return this
  }

  bodyLimit(bytes: number) {
    this.#_bodyLimit = bytes
    return this
  }

  timeout(ms: number) {
    this.#_timeout = ms
    return this
  }

  describe<R = unknown>(): Exclude<Router<R>, 'key' | 'binding' | 'controller'> {
    return this.toRouter(
      null as unknown as Key,
      null as unknown as Binding<unknown>,
      null as unknown as Provider<Record<string | symbol, (...args: unknown[]) => unknown>>,
    )
  }

  toRouter<R>(
    key: Key,
    binding: Binding<unknown>,
    controller: Provider<Record<string | symbol, (...args: unknown[]) => unknown>>,
  ): Router<R> {
    return {
      path: normalizePrefix(this._path ?? ''),
      prefix: this.#_prefix,
      routes: (this.#_routes ?? []).map(route => route.toRoute<R>()),
      header: this.#_header,
      accept: [...(this.#_consumes ?? [])],
      contentType: this.#_produces,
      bodyLimit: this.#_bodyLimit,
      timeout: this.#_timeout,
      key,
      binding,
      controller,
    }
  }
}

export class RouteBuilder {
  #header?: Map<string, string | string[]>
  #path?: string
  #method?: string[]
  #handler?: string | symbol
  #parameters?: ParameterPickOptions<unknown>[]
  #consumes?: string[]
  #produces: string = ''
  #schema?: RouteValidationSchema
  #bodyLimit?: number
  #timeout?: number
  #statusCode?: number
  #extras?: Map<symbol, unknown>

  header(name: string, value: string | string[]) {
    this.#header ??= new Map()
    this.#header.set(name, value)
    return this
  }

  path(path: string) {
    this.#path = path
    return this
  }

  method(method: string | string[]): this {
    this.#method ??= []
    this.#method.push(...(Array.isArray(method) ? method : [method]))
    return this
  }

  handler(handler: string | symbol): this {
    this.#handler = handler
    return this
  }

  parameters(parameters: ParameterPickOptions<unknown> | ParameterPickOptions<unknown>[]) {
    this.#parameters ??= []
    this.#parameters.push(...(Array.isArray(parameters) ? parameters : [parameters]))
    return this
  }

  consumes(consumes: string | string[]) {
    this.#consumes ??= []
    this.#consumes.push(...(Array.isArray(consumes) ? consumes : [consumes]))
    return this
  }

  produces(produces: string) {
    this.#produces = produces
    return this
  }

  schema<S extends RouteValidationSchema>(schema: S): this {
    this.#schema = schema
    return this
  }

  bodyLimit(bytes: number): this {
    this.#bodyLimit = bytes
    return this
  }

  timeout(ms: number): this {
    this.#timeout = ms
    return this
  }

  statusCode(code: number): this {
    this.#statusCode = code
    return this
  }

  extras(extras: Map<symbol, unknown>): this {
    this.#extras ??= new Map()
    for (const [key, value] of extras) {
      this.#extras.set(key, value)
    }
    return this
  }

  extra<K extends symbol>(key: K, value: unknown): this {
    this.#extras ??= new Map()
    this.#extras.set(key, value)
    return this
  }

  toRoute<R>(): Route<R> {
    return {
      path: normalizePath(this.#path ?? ''),
      method: [...(this.#method ?? [])],
      accept: [...(this.#consumes ?? [])],
      contentType: this.#produces ?? '',
      parameters: [...(this.#parameters ?? [])],
      handler: this.#handler ?? '',
      schema: this.#schema,
      bodyLimit: this.#bodyLimit,
      timeout: this.#timeout,
      header: this.#header,
      statusCode: this.#statusCode,
      extras: this.#extras ?? new Map(),
    }
  }
}

function normalizePrefix(prefix: string): string {
  return prefix.replace(/\/+$/, '')
}

function normalizePath(path: string): string {
  const withLeading = path.startsWith('/') ? path : `/${path}`
  const collapsed = withLeading.replace(/\/+/g, '/')
  return collapsed.length > 1 ? collapsed.replace(/\/$/, '') : collapsed
}

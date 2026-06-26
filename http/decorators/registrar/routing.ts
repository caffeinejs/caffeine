import { Binding, Key, Provider } from '@caffeinejs/core'
import { Route, Router, RouteValidationSchema } from '../../route.js'
import { ParameterPickOptions } from '../../route.picker.js'

function normalizePrefix(prefix: string): string {
  return prefix.replace(/\/+$/, '')
}

function normalizePath(path: string): string {
  const withLeading = path.startsWith('/') ? path : `/${path}`
  const collapsed = withLeading.replace(/\/+/g, '/')
  return collapsed.length > 1 ? collapsed.replace(/\/$/, '') : collapsed
}

export function joinPaths(base: string, path: string): string {
  const joined = `${base}${path}`
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined || '/'
}

export class RouterBuilder {
  _path?: string
  #_prefix?: string
  #_header?: Map<string, string | string[]>
  #_consumes?: string[]
  #_produces?: string[]
  #_routes?: RouteBuilder[]
  #_bodyLimit?: number
  #_timeout?: number

  path(path: string) {
    this._path = path
  }

  header(name: string, value: string | string[]) {
    this.#_header ??= new Map()
    this.#_header.set(name, value)
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

  prefix(prefix: string) {
    this.#_prefix = prefix
  }

  bodyLimit(bytes: number) {
    this.#_bodyLimit = bytes
  }

  timeout(ms: number) {
    this.#_timeout = ms
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
      header: new Map(this.#_header),
      accept: [...(this.#_consumes ?? [])],
      contentTypes: [...(this.#_produces ?? [])],
      bodyLimit: this.#_bodyLimit,
      timeout: this.#_timeout,
      key,
      binding,
      controller,
    }
  }
}

export class RouteBuilder {
  #_header?: Map<string, string | string[]>
  #_path?: string
  #_method?: string[]
  #_handler?: string | symbol
  #_parameters?: ParameterPickOptions<unknown>[]
  #_consumes?: string[]
  #_produces?: string[]
  #_schema?: RouteValidationSchema
  #_bodyLimit?: number
  #_timeout?: number
  #_statusCode?: number

  header(name: string, value: string | string[]) {
    this.#_header ??= new Map()
    this.#_header.set(name, value)
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

  schema<S extends RouteValidationSchema>(schema: S): this {
    this.#_schema = schema
    return this
  }

  bodyLimit(bytes: number): this {
    this.#_bodyLimit = bytes
    return this
  }

  timeout(ms: number): this {
    this.#_timeout = ms
    return this
  }

  statusCode(code: number): this {
    this.#_statusCode = code
    return this
  }

  toRoute<R>(): Route<R> {
    return {
      path: normalizePath(this.#_path ?? ''),
      method: [...(this.#_method ?? [])],
      accept: [...(this.#_consumes ?? [])],
      contentTypes: [...(this.#_produces ?? [])],
      parameters: [...(this.#_parameters ?? [])],
      handler: this.#_handler ?? '',
      response: { status: this.#_statusCode, header: new Map(this.#_header) },
      schema: this.#_schema,
      bodyLimit: this.#_bodyLimit,
      timeout: this.#_timeout,
    }
  }
}

import type { Ctor } from '@caffeinejs/di'
import type { ParameterPickOptions } from '@caffeinejs/std/framework'
import type { RouteValidationSchema } from '../../route.js'
import type { ErrorHandlerRef } from '../../error/error.js'
import type { RouteAuthzOptions, RouterSpec, RouteSpec } from './routing.definition.js'
import { mergeValue } from './_merge.js'

export class RouterBuilder {
  #path?: string
  #prefix?: string
  #header?: Map<string, string | string[]>
  #consumes?: string[]
  #produces: string = ''
  #routes?: RouteBuilder[]
  #bodyLimit?: number
  #timeout?: number
  #authorize?: RouteAuthzOptions
  #config?: Map<string, unknown>
  #options?: Map<string, unknown>
  #extras?: Map<symbol, unknown>
  #errorHandlers?: Array<[Ctor<Error>, string | symbol]>
  #catchBy?: ErrorHandlerRef[]

  path(path: string) {
    this.#path = path
    return this
  }

  header(name: string, value: string | string[]) {
    this.#header ??= new Map()
    this.#header.set(name, value)
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

  errorHandlers(handlers: Array<[Ctor<Error>, string | symbol]>) {
    this.#errorHandlers = handlers
    return this
  }

  catchBy(handlers: ErrorHandlerRef[]) {
    this.#catchBy ??= []
    this.#catchBy.push(...handlers)
    return this
  }

  routes(routes: RouteBuilder | RouteBuilder[]) {
    this.#routes ??= []
    this.#routes.push(...(Array.isArray(routes) ? routes : [routes]))
    return this
  }

  prefix(prefix: string) {
    this.#prefix = prefix
    return this
  }

  bodyLimit(bytes: number) {
    this.#bodyLimit = bytes
    return this
  }

  timeout(ms: number) {
    this.#timeout = ms
    return this
  }

  authorize(opts: RouteAuthzOptions) {
    this.#authorize = opts
    return this
  }

  config<K extends string>(key: K, value: unknown): this
  config<K extends string>(config: Map<K, unknown>): this
  config<K extends string>(keyOrConfig: K | Map<K, unknown>, value?: unknown): this {
    this.#config ??= new Map()
    if (typeof keyOrConfig === 'string') {
      this.#config.set(keyOrConfig, mergeValue(this.#config.get(keyOrConfig), value))
    } else {
      for (const [key, value] of keyOrConfig) {
        this.#config.set(key, mergeValue(this.#config.get(key), value))
      }
    }
    return this
  }

  options<K extends string>(key: K, value: unknown): this
  options<K extends string>(options: Map<K, unknown>): this
  options<K extends string>(keyOrOptions: K | Map<K, unknown>, value?: unknown): this {
    this.#options ??= new Map()
    if (typeof keyOrOptions === 'string') {
      this.#options.set(keyOrOptions, mergeValue(this.#options.get(keyOrOptions), value))
    } else {
      for (const [key, value] of keyOrOptions) {
        this.#options.set(key, mergeValue(this.#options.get(key), value))
      }
    }
    return this
  }

  extras<K extends symbol>(key: K, value: unknown): this
  extras<K extends symbol>(extras: Map<K, unknown>): this
  extras<K extends symbol>(keyOrExtras: K | Map<K, unknown>, value?: unknown): this {
    this.#extras ??= new Map()
    if (typeof keyOrExtras === 'symbol') {
      this.#extras.set(keyOrExtras, mergeValue(this.#extras.get(keyOrExtras), value))
    } else {
      for (const [key, value] of keyOrExtras) {
        this.#extras.set(key, mergeValue(this.#extras.get(key), value))
      }
    }
    return this
  }

  // TODO: remove this
  describe<R = unknown>(): RouterSpec<R> {
    return this.toRouter()
  }

  toRouter<R>(): RouterSpec<R> {
    return {
      path: normalizePrefix(this.#path ?? ''),
      prefix: this.#prefix,
      routes: (this.#routes ?? []).map(route => route.toRoute<R>()),
      header: this.#header,
      accept: [...(this.#consumes ?? [])],
      contentType: this.#produces,
      bodyLimit: this.#bodyLimit,
      timeout: this.#timeout,
      authz: this.#authorize,
      config: this.#config,
      options: this.#options,
      extras: this.#extras,
      errorHandlers: this.#errorHandlers,
      catchBy: this.#catchBy,
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
  #authorize?: RouteAuthzOptions
  #config?: Map<string, unknown>
  #options?: Map<string, unknown>
  #extras?: Map<symbol, unknown>
  #catchBy?: ErrorHandlerRef[]

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

  authorize(opts: RouteAuthzOptions): this {
    this.#authorize = opts
    return this
  }

  catchBy(handlers: ErrorHandlerRef[]): this {
    this.#catchBy ??= []
    this.#catchBy.push(...handlers)
    return this
  }

  config<K extends string>(key: K, value: unknown): this
  config<K extends string>(config: Map<K, unknown>): this
  config<K extends string>(keyOrConfig: K | Map<K, unknown>, value?: unknown): this {
    this.#config ??= new Map()
    if (typeof keyOrConfig === 'string') {
      this.#config.set(keyOrConfig, mergeValue(this.#config.get(keyOrConfig), value))
    } else {
      for (const [key, value] of keyOrConfig) {
        this.#config.set(key, mergeValue(this.#config.get(key), value))
      }
    }
    return this
  }

  options<K extends string>(key: K, value: unknown): this
  options<K extends string>(options: Map<K, unknown>): this
  options<K extends string>(keyOrOptions: K | Map<K, unknown>, value?: unknown): this {
    this.#options ??= new Map()
    if (typeof keyOrOptions === 'string') {
      this.#options.set(keyOrOptions, mergeValue(this.#options.get(keyOrOptions), value))
    } else {
      for (const [key, value] of keyOrOptions) {
        this.#options.set(key, mergeValue(this.#options.get(key), value))
      }
    }
    return this
  }

  extras<K extends symbol>(key: K, value: unknown): this
  extras<K extends symbol>(extras: Map<K, unknown>): this
  extras<K extends symbol>(keyOrExtras: K | Map<K, unknown>, value?: unknown): this {
    this.#extras ??= new Map()
    if (typeof keyOrExtras === 'symbol') {
      this.#extras.set(keyOrExtras, mergeValue(this.#extras.get(keyOrExtras), value))
    } else {
      for (const [key, value] of keyOrExtras) {
        this.#extras.set(key, mergeValue(this.#extras.get(key), value))
      }
    }
    return this
  }

  toRoute<R>(): RouteSpec<R> {
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
      authz: this.#authorize,
      config: this.#config,
      options: this.#options,
      extras: this.#extras,
      catchBy: this.#catchBy,
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

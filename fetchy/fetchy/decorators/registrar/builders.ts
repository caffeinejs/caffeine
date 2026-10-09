import type { ParamDescriptor } from '../../internal/param_descriptor.js'
import { normalizePath } from '../../internal/path_util.js'
import type { RequestBodyConverter } from '../../request_body_converter.js'
import type { ResponseConverter } from '../../response_converter.js'
import type { ResponseHandler } from '../../response_handler.js'
import type { RetryOptions } from '../../retry_options.js'
import type { ClassSpec, MethodSpec } from './builders.definition.js'

export class ClassBuilder {
  #api = false
  #path?: string
  #headers?: Headers
  #formURLEncoded = false
  #multipart = false
  #responseConverter?: ResponseConverter
  #requestBodyConverter?: RequestBodyConverter
  #responseHandler?: ResponseHandler
  #retry?: RetryOptions

  api(): this {
    this.#api = true
    return this
  }

  isAPI(): boolean {
    return this.#api
  }

  path(path: string): this {
    this.#path = path
    return this
  }

  header(name: string, value: string): this {
    this.#headers ??= new Headers()
    this.#headers.set(name, value)
    return this
  }

  formURLEncoded(): this {
    this.#formURLEncoded = true
    return this
  }

  multipart(): this {
    this.#multipart = true
    return this
  }

  responseConverter(converter: ResponseConverter): this {
    this.#responseConverter = converter
    return this
  }

  requestBodyConverter(converter: RequestBodyConverter): this {
    this.#requestBodyConverter = converter
    return this
  }

  responseHandler(handler: ResponseHandler): this {
    this.#responseHandler = handler
    return this
  }

  retry(options: RetryOptions): this {
    this.#retry = options
    return this
  }

  toClassSpec(): ClassSpec {
    return {
      // Unset stays undefined, so a subclass that sets no path keeps its base class's, while `''` clears it.
      path: this.#path === undefined ? undefined : normalizePath(this.#path),
      headers: this.#headers ?? new Headers(),
      formURLEncoded: this.#formURLEncoded,
      multipart: this.#multipart,
      responseConverter: this.#responseConverter,
      requestBodyConverter: this.#requestBodyConverter,
      responseHandler: this.#responseHandler,
      retry: this.#retry,
    }
  }
}

export class MethodBuilder {
  /** The member that declares the operation. */
  readonly name: string | symbol
  /** The key under which a client built by `FetchyClient.create()` holds this operation's invoker. */
  readonly key: symbol

  #httpMethod?: string
  #path?: string
  #headers?: Headers
  #params: ParamDescriptor[] = []
  #formURLEncoded = false
  #multipart = false
  #responseConverter?: ResponseConverter
  #requestBodyConverter?: RequestBodyConverter
  #responseHandler?: ResponseHandler
  #callback = false
  #retry?: RetryOptions
  #noRetry = false

  constructor(name: string | symbol) {
    this.name = name
    this.key = Symbol(String(name))
  }

  httpMethod(method: string): this {
    this.#httpMethod = method
    return this
  }

  callback(value: boolean): this {
    this.#callback = value
    return this
  }

  retry(options: RetryOptions): this {
    this.#retry = options
    return this
  }

  noRetry(value: boolean): this {
    this.#noRetry = value
    return this
  }

  path(path: string): this {
    this.#path = path
    return this
  }

  header(name: string, value: string): this {
    this.#headers ??= new Headers()
    this.#headers.set(name, value)
    return this
  }

  param(descriptor: ParamDescriptor): this {
    this.#params.push(descriptor)
    return this
  }

  formURLEncoded(): this {
    this.#formURLEncoded = true
    return this
  }

  multipart(): this {
    this.#multipart = true
    return this
  }

  responseConverter(converter: ResponseConverter): this {
    this.#responseConverter = converter
    return this
  }

  requestBodyConverter(converter: RequestBodyConverter): this {
    this.#requestBodyConverter = converter
    return this
  }

  responseHandler(handler: ResponseHandler): this {
    this.#responseHandler = handler
    return this
  }

  toMethodSpec(): MethodSpec {
    return {
      name: String(this.name),
      httpMethod: this.#httpMethod ?? '',
      path: normalizePath(this.#path ?? ''),
      headers: this.#headers ?? new Headers(),
      params: [...this.#params],
      formURLEncoded: this.#formURLEncoded,
      multipart: this.#multipart,
      responseConverter: this.#responseConverter,
      requestBodyConverter: this.#requestBodyConverter,
      responseHandler: this.#responseHandler,
      callback: this.#callback,
      retry: this.#retry,
      noRetry: this.#noRetry,
    }
  }
}

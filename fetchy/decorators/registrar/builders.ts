import type { ParamDescriptor } from '../../internal/param_descriptor.js'
import { normalizePath } from '../../internal/path_util.js'
import type { ResponseConverter } from '../../response_converter.js'
import type { ClassSpec, MethodSpec } from './builders.definition.js'

export class ClassBuilder {
  #path?: string
  #headers?: Headers
  #requestType?: string
  #responseConverter?: ResponseConverter

  path(path: string): this {
    this.#path = path
    return this
  }

  header(name: string, value: string): this {
    this.#headers ??= new Headers()
    this.#headers.set(name, value)
    return this
  }

  requestType(type: string): this {
    this.#requestType = type
    return this
  }

  responseConverter(converter: ResponseConverter): this {
    this.#responseConverter = converter
    return this
  }

  toClassSpec(): ClassSpec {
    return {
      path: normalizePath(this.#path ?? ''),
      headers: this.#headers ?? new Headers(),
      requestType: this.#requestType,
      responseConverter: this.#responseConverter,
    }
  }
}

export class MethodBuilder {
  #httpMethod?: string
  #path?: string
  #headers?: Headers
  #params: ParamDescriptor[] = []
  #formURLEncoded = false
  #requestType?: string
  #responseConverter?: ResponseConverter
  #kind: 'method' | 'field' = 'method'

  httpMethod(method: string): this {
    this.#httpMethod = method
    return this
  }

  kind(kind: 'method' | 'field'): this {
    this.#kind = kind
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

  requestType(type: string): this {
    this.#requestType = type
    return this
  }

  responseConverter(converter: ResponseConverter): this {
    this.#responseConverter = converter
    return this
  }

  toMethodSpec(): MethodSpec {
    return {
      httpMethod: this.#httpMethod ?? '',
      path: normalizePath(this.#path ?? ''),
      headers: this.#headers ?? new Headers(),
      params: [...this.#params],
      formURLEncoded: this.#formURLEncoded,
      requestType: this.#requestType,
      responseConverter: this.#responseConverter,
      kind: this.#kind,
    }
  }
}

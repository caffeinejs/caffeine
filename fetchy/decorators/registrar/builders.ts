import type { ParamDescriptor } from '../../internal/param_descriptor.js'
import { normalizePath } from '../../internal/path_util.js'
import type { ClassSpec, MethodSpec } from './builders.definition.js'

export class ClassBuilder {
  #path?: string
  #headers?: Headers
  #requestType?: string
  #responseType?: string

  path(path: string): this {
    this.#path = path
    return this
  }

  header(name: string, value: string): this {
    this.#headers ??= new Headers()
    this.#headers.append(name, value)
    return this
  }

  requestType(type: string): this {
    this.#requestType = type
    return this
  }

  responseType(type: string): this {
    this.#responseType = type
    return this
  }

  toClassSpec(): ClassSpec {
    return {
      path: normalizePath(this.#path ?? ''),
      headers: this.#headers ?? new Headers(),
      requestType: this.#requestType,
      responseType: this.#responseType,
    }
  }
}

export class MethodBuilder {
  #httpMethod?: string
  #path?: string
  #headers?: Headers
  #params: ParamDescriptor[] = []
  #bodyIndex = -1
  #argLen = 0
  #formURLEncoded = false
  #requestType?: string
  #responseType?: string

  /**
   * Runtime wiring set by `FetchyClient.create()` — not decorator configuration, deliberately
   * excluded from `toMethodSpec()`'s snapshot.
   */
  invoker: ((...args: unknown[]) => unknown) | null = null
  /** Set once this method has been merged/validated/wired by a `FetchyClient.create()` call. */
  processed = false

  httpMethod(method: string): this {
    this.#httpMethod = method
    return this
  }

  path(path: string): this {
    this.#path = path
    return this
  }

  header(name: string, value: string): this {
    this.#headers ??= new Headers()
    this.#headers.append(name, value)
    return this
  }

  param(descriptor: ParamDescriptor): this {
    this.#params.push(descriptor)

    if (descriptor.kind === 'body') {
      this.#bodyIndex = descriptor.index
    }

    return this
  }

  argLen(length: number): this {
    this.#argLen = length
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

  responseType(type: string): this {
    this.#responseType = type
    return this
  }

  toMethodSpec(): MethodSpec {
    return {
      httpMethod: this.#httpMethod ?? '',
      path: normalizePath(this.#path ?? ''),
      headers: this.#headers ?? new Headers(),
      params: [...this.#params],
      bodyIndex: this.#bodyIndex,
      argLen: this.#argLen,
      formURLEncoded: this.#formURLEncoded,
      requestType: this.#requestType,
      responseType: this.#responseType,
    }
  }
}

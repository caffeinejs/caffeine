import type { Call, CallFactory } from './call.js'
import type { CallAdapterFactory } from './call_adapter.js'
import { ErrFetchyEmptyClient, ErrFetchyInvalidRoute } from './errors.js'
import { mergeHeaders } from './headers_util.js'
import type { Interceptor } from './interceptor.js'
import { joinPaths } from './internal/path_util.js'
import { allMethodMeta, ClassMeta, readClassMeta } from './metadata.js'
import type { MethodMeta } from './metadata.js'
import { JsonResponseConverter } from './response_converter.js'
import type { ResponseConverter } from './response_converter.js'
import { buildInvoker } from './service_invoker.js'

type AnyCtor = new (...args: any[]) => any

export interface FetchyClientOptions {
  baseUrl: string
  callFactory: CallFactory
  interceptors: readonly Interceptor[]
  callAdapterFactories: readonly CallAdapterFactory[]
  responseConverter?: ResponseConverter
}

function mergeClassIntoMethod(defaults: ClassMeta, meta: MethodMeta): void {
  meta.path = joinPaths(defaults.path, meta.path)
  meta.headers = mergeHeaders(defaults.headers, meta.headers)
  meta.requestType ??= defaults.requestType
  meta.responseType ??= defaults.responseType

  if (!meta.formUrlEncoded && meta.requestType === 'form') {
    meta.formUrlEncoded = true
  }
}

function validateMethodMeta(name: string, meta: MethodMeta): void {
  if (!meta.httpMethod) {
    throw new ErrFetchyInvalidRoute(name, 'missing an HTTP verb decorator (@GET/@POST/etc)')
  }

  const bodyParamCount = meta.params.filter(param => param.kind === 'body').length

  if (bodyParamCount > 1) {
    throw new ErrFetchyInvalidRoute(name, 'more than one @Body() parameter is not allowed')
  }

  if (bodyParamCount > 0 && (meta.httpMethod === 'GET' || meta.httpMethod === 'HEAD' || meta.httpMethod === 'OPTIONS')) {
    throw new ErrFetchyInvalidRoute(name, `${meta.httpMethod} requests cannot have a body`)
  }

  const hasFormFields = meta.params.some(param => param.kind === 'form-field')

  if (hasFormFields && !meta.formUrlEncoded) {
    throw new ErrFetchyInvalidRoute(name, '@Field() requires @FormUrlEncoded() on the method or class')
  }

  const pathKeys = new Set(
    meta.params.filter(param => param.kind === 'path').map(param => (param as { key: string }).key),
  )
  const placeholders = new Set(Array.from(meta.path.matchAll(/\{(\w+)\}/g), match => match[1]))

  for (const key of pathKeys) {
    if (!placeholders.has(key)) {
      throw new ErrFetchyInvalidRoute(
        name,
        `@Param("${key}") has no matching "{${key}}" placeholder in path "${meta.path}"`,
      )
    }
  }

  for (const placeholder of placeholders) {
    if (!pathKeys.has(placeholder)) {
      throw new ErrFetchyInvalidRoute(
        name,
        `path placeholder "{${placeholder}}" has no matching @Param("${placeholder}")`,
      )
    }
  }
}

/**
 * Runtime registry produced by {@link FetchyBuilder}. `create()` turns a decorated class into a
 * working client by reading its configuration straight from `TargetApi[Symbol.metadata]`.
 *
 * Note: a decorated method's built invoker lives on the class's own (shared) metadata, not on the
 * created instance — calling `create()` a second time on the same class reuses the first
 * invocation's wiring rather than replacing it. Each decorated class is expected to be built by
 * one canonical client configuration.
 */
export class FetchyClient {
  private readonly call: Call

  constructor(private readonly options: FetchyClientOptions) {
    this.call = options.callFactory.provide(options.baseUrl)
  }

  private static mixin<T extends AnyCtor>(superclass: T) {
    return class extends superclass {}
  }

  create<T extends AnyCtor>(TargetApi: T, ...args: ConstructorParameters<T>): InstanceType<T> {
    const metadata = (TargetApi as unknown as { [Symbol.metadata]?: DecoratorMetadataObject })[Symbol.metadata]
    const methods = metadata ? allMethodMeta(metadata) : new Map<string | symbol, MethodMeta>()

    if (methods.size === 0) {
      throw new ErrFetchyEmptyClient(TargetApi.name)
    }

    const defaults = (metadata && readClassMeta(metadata)) ?? new ClassMeta()
    const responseConverter = this.options.responseConverter ?? JsonResponseConverter

    for (const [name, meta] of methods) {
      if (meta.processed) {
        continue
      }

      mergeClassIntoMethod(defaults, meta)
      validateMethodMeta(String(name), meta)

      meta.invoker = buildInvoker(
        {
          baseUrl: this.options.baseUrl,
          call: this.call,
          interceptors: this.options.interceptors,
          responseConverter,
          errorResponseConverter: responseConverter,
          callAdapterFactories: this.options.callAdapterFactories,
        },
        meta,
      )
      meta.processed = true
    }

    const Extended = FetchyClient.mixin(TargetApi)

    return new Extended(...args) as InstanceType<T>
  }
}

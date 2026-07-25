import type { Call, CallFactory } from './call.js'
import type { CallAdapterFactory } from './call_adapter.js'
import { getClassBuilder, getMethodBuilders } from './decorators/registrar/registrar.js'
import type { ClassSpec, MethodBuilder, MethodSpec } from './decorators/registrar/index.js'
import { ErrFetchyEmptyClient, ErrFetchyInvalidRoute } from './errors.js'
import { mergeHeaders } from './headers_util.js'
import type { Interceptor } from './interceptor.js'
import { joinPaths } from './internal/path_util.js'
import { JSONResponseConverter } from './response_converter.js'
import type { ResponseConverter } from './response_converter.js'
import { buildInvoker } from './service_invoker.js'

type AnyCtor = new (...args: any[]) => any

export interface FetchyClientOptions {
  baseURL: string
  callFactory: CallFactory
  interceptors: readonly Interceptor[]
  callAdapterFactories: readonly CallAdapterFactory[]
  responseConverter?: ResponseConverter
}

const DEFAULT_CLASS_SPEC: ClassSpec = {
  path: '',
  headers: new Headers(),
  requestType: undefined,
  responseType: undefined,
}

function mergeClassIntoMethod(defaults: ClassSpec, spec: MethodSpec): MethodSpec {
  const requestType = spec.requestType ?? defaults.requestType

  return {
    ...spec,
    path: joinPaths(defaults.path, spec.path),
    headers: mergeHeaders(defaults.headers, spec.headers),
    requestType,
    responseType: spec.responseType ?? defaults.responseType,
    formURLEncoded: spec.formURLEncoded || requestType === 'form',
  }
}

function validateMethodSpec(name: string, spec: MethodSpec): void {
  if (!spec.httpMethod) {
    throw new ErrFetchyInvalidRoute(name, 'missing an HTTP verb decorator (@GET/@POST/etc)')
  }

  const bodyParamCount = spec.params.filter(param => param.kind === 'body').length

  if (bodyParamCount > 1) {
    throw new ErrFetchyInvalidRoute(name, 'more than one @Body() parameter is not allowed')
  }

  if (bodyParamCount > 0 && (spec.httpMethod === 'GET' || spec.httpMethod === 'HEAD' || spec.httpMethod === 'OPTIONS')) {
    throw new ErrFetchyInvalidRoute(name, `${spec.httpMethod} requests cannot have a body`)
  }

  const hasFormFields = spec.params.some(param => param.kind === 'form-field')

  if (hasFormFields && !spec.formURLEncoded) {
    throw new ErrFetchyInvalidRoute(name, '@Field() requires @FormURLEncoded() on the method or class')
  }

  const pathKeys = new Set(
    spec.params.filter(param => param.kind === 'path').map(param => (param as { key: string }).key),
  )
  const placeholders = new Set(Array.from(spec.path.matchAll(/\{(\w+)\}/g), match => match[1]))

  for (const key of pathKeys) {
    if (!placeholders.has(key)) {
      throw new ErrFetchyInvalidRoute(
        name,
        `@Param("${key}") has no matching "{${key}}" placeholder in path "${spec.path}"`,
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
 * working client by reading its configuration from the class's registrar entries (looked up via
 * `TargetAPI[Symbol.metadata]` as an opaque WeakMap key — see `decorators/registrar/registrar.ts`).
 *
 * Note: a decorated method's built invoker lives on the class's own (shared) `MethodBuilder`, not
 * on the created instance — calling `create()` a second time on the same class reuses the first
 * invocation's wiring rather than replacing it. Each decorated class is expected to be built by
 * one canonical client configuration.
 */
export class FetchyClient {
  private readonly call: Call

  constructor(private readonly options: FetchyClientOptions) {
    this.call = options.callFactory.provide(options.baseURL)
  }

  private static mixin<T extends AnyCtor>(superclass: T) {
    return class extends superclass {}
  }

  create<T extends AnyCtor>(TargetAPI: T, ...args: ConstructorParameters<T>): InstanceType<T> {
    const metadata = (TargetAPI as unknown as { [Symbol.metadata]?: object })[Symbol.metadata]
    const methods = metadata ? getMethodBuilders(metadata) : new Map<string | symbol, MethodBuilder>()

    if (methods.size === 0) {
      throw new ErrFetchyEmptyClient(TargetAPI.name)
    }

    const classSpec = (metadata && getClassBuilder(metadata)?.toClassSpec()) ?? DEFAULT_CLASS_SPEC
    const responseConverter = this.options.responseConverter ?? JSONResponseConverter

    for (const [name, builder] of methods) {
      if (builder.processed) {
        continue
      }

      const spec = mergeClassIntoMethod(classSpec, builder.toMethodSpec())
      validateMethodSpec(String(name), spec)

      builder.invoker = buildInvoker(
        {
          baseURL: this.options.baseURL,
          call: this.call,
          interceptors: this.options.interceptors,
          responseConverter,
          errorResponseConverter: responseConverter,
          callAdapterFactories: this.options.callAdapterFactories,
        },
        spec,
      )
      builder.processed = true
    }

    const Extended = FetchyClient.mixin(TargetAPI)

    return new Extended(...args) as InstanceType<T>
  }
}

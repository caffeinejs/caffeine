import type { Call, CallFactory } from './call.js'
import type { CallAdapterFactory } from './call_adapter.js'
import type { ClassSpec, MethodSpec } from './decorators/registrar/index.js'
import { getAPI } from './decorators/registrar/registrar.js'
import { ErrFetchyEmptyClient, ErrFetchyInvalidRoute, ErrFetchyMissingAPIDecorator } from './errors.js'
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

function mergeClassIntoMethod(defaults: ClassSpec, spec: MethodSpec): MethodSpec {
  const requestType = spec.requestType ?? defaults.requestType

  return {
    ...spec,
    path: joinPaths(defaults.path, spec.path),
    headers: mergeHeaders(defaults.headers, spec.headers),
    requestType,
    responseConverter: spec.responseConverter ?? defaults.responseConverter,
    requestBodyConverter: spec.requestBodyConverter ?? defaults.requestBodyConverter,
    responseHandler: spec.responseHandler ?? defaults.responseHandler,
    formURLEncoded: spec.formURLEncoded || requestType === 'form',
    retry: spec.retry ?? defaults.retry,
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

  if (
    bodyParamCount > 0 &&
    (spec.httpMethod === 'GET' || spec.httpMethod === 'HEAD' || spec.httpMethod === 'OPTIONS')
  ) {
    throw new ErrFetchyInvalidRoute(name, `${spec.httpMethod} requests cannot have a body`)
  }

  const hasFormFields = spec.params.some(param => param.kind === 'form-field')

  if (hasFormFields && !spec.formURLEncoded) {
    throw new ErrFetchyInvalidRoute(name, '@Field() requires @FormURLEncoded() on the method or class')
  }

  if (hasFormFields && bodyParamCount > 0) {
    throw new ErrFetchyInvalidRoute(name, '@Body() and @Field() cannot be used on the same method')
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
 * working client by reading its configuration from the class's `@API()`-drained registry entry
 * (looked up by the class constructor itself — see `decorators/registrar/registrar.ts`), then
 * assigning a freshly-built HTTP-performing implementation onto each decorated method name as an
 * own property of the created instance — shadowing the class's own (throwing) method body.
 *
 * Each `create()` call is fully independent: it builds its own instance and its own invokers, so
 * calling `create()` multiple times on the same class (e.g. with different `baseURL`s) never
 * shares wiring between instances.
 */
export class FetchyClient {
  private readonly call: Call

  constructor(private readonly options: FetchyClientOptions) {
    this.call = options.callFactory.provide(options.baseURL)
  }

  create<T extends AnyCtor>(TargetAPI: T, ...args: ConstructorParameters<T>): InstanceType<T> {
    const entry = getAPI(TargetAPI)

    if (!entry) {
      throw new ErrFetchyMissingAPIDecorator(TargetAPI.name)
    }

    const { classSpec, methods } = entry

    if (methods.size === 0) {
      throw new ErrFetchyEmptyClient(TargetAPI.name)
    }

    const instance = new TargetAPI(...args) as InstanceType<T>

    for (const [name, builder] of methods) {
      const spec = mergeClassIntoMethod(classSpec, builder.toMethodSpec())
      validateMethodSpec(String(name), spec)

      const responseConverter = spec.responseConverter ?? this.options.responseConverter ?? JSONResponseConverter

      Object.defineProperty(instance, name, {
        value: buildInvoker(
          {
            baseURL: this.options.baseURL,
            call: this.call,
            interceptors: this.options.interceptors,
            responseConverter,
            errorResponseConverter: responseConverter,
            callAdapterFactories: this.options.callAdapterFactories,
          },
          spec,
        ),
        writable: true,
        configurable: true,
        enumerable: spec.kind === 'field',
      })
    }

    return instance
  }
}

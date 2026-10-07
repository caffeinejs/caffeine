import type { CallAdapterFactory } from './call_adapter.js'
import type { ClassSpec, MethodSpec } from './decorators/registrar/index.js'
import { type DeclaringClass, getDeclaringClasses } from './decorators/registrar/registrar.js'
import { ErrFetchyEmptyClient, ErrFetchyInvalidRoute, ErrFetchyMissingAPIDecorator } from './errors.js'
import { mergeHeaders } from './headers_util.js'
import type { Interceptor } from './interceptor.js'
import { joinPaths } from './internal/path_util.js'
import { JSONResponseConverter } from './response_converter.js'
import type { ResponseConverter } from './response_converter.js'
import { buildInvoker, type Invoker } from './service_invoker.js'
import type { Transport, TransportFactory } from './transport.js'

type AnyCtor = new (...args: any[]) => any

export interface FetchyClientOptions {
  baseURL: string
  transportFactory: TransportFactory
  interceptors: readonly Interceptor[]
  callAdapterFactories: readonly CallAdapterFactory[]
  responseConverter?: ResponseConverter
}

// An operation as every client of one class serves it: the key a client holds its invoker under, the name errors
// give it, and its configuration once the class chain's is merged in and validated.
interface Operation {
  readonly key: symbol
  readonly label: string
  readonly spec: MethodSpec
}

// The walk, the merge and the validation depend on the class alone, so they run once per class. A class that fails
// is not cached: it fails the same way on every `create()`.
const operationsByClass = new WeakMap<Function, readonly Operation[]>()

function operationsOf(target: Function): readonly Operation[] {
  let operations = operationsByClass.get(target)

  if (operations === undefined) {
    operations = resolveOperations(target)
    operationsByClass.set(target, operations)
  }

  return operations
}

function resolveOperations(target: Function): readonly Operation[] {
  const chain = getDeclaringClasses(target)

  if (!chain.some(declaring => declaring.classBuilder?.isAPI())) {
    throw new ErrFetchyMissingAPIDecorator(target.name)
  }

  if (!chain.some(declaring => declaring.methods.length > 0)) {
    throw new ErrFetchyEmptyClient(target.name)
  }

  const classSpec = mergeClassSpecs(chain)
  const operations: Operation[] = []

  // Overridden operations are validated too: `super` still reaches them.
  for (const { owner, methods } of chain) {
    for (const builder of methods) {
      const spec = mergeClassIntoMethod(classSpec, builder.toMethodSpec())
      const label = `${owner.name}.${spec.name}`

      validateMethodSpec(label, spec)
      operations.push({ key: builder.key, label, spec })
    }
  }

  return operations
}

// Root to leaf: a subclass replaces what its base classes set where it sets something itself, headers merge by name,
// and `@FormURLEncoded()` applies from any level. The result serves every operation in the chain, inherited ones
// included, so a base class's operation is sent under its subclass's path.
function mergeClassSpecs(chain: readonly DeclaringClass[]): ClassSpec {
  const merged: ClassSpec = {
    path: undefined,
    headers: new Headers(),
    formURLEncoded: false,
    responseConverter: undefined,
    requestBodyConverter: undefined,
    responseHandler: undefined,
    retry: undefined,
  }

  for (const { classBuilder } of chain) {
    if (classBuilder === undefined) {
      continue
    }

    const spec = classBuilder.toClassSpec()

    merged.path = spec.path ?? merged.path
    merged.formURLEncoded ||= spec.formURLEncoded
    merged.responseConverter = spec.responseConverter ?? merged.responseConverter
    merged.requestBodyConverter = spec.requestBodyConverter ?? merged.requestBodyConverter
    merged.responseHandler = spec.responseHandler ?? merged.responseHandler
    merged.retry = spec.retry ?? merged.retry

    for (const [name, value] of spec.headers) {
      merged.headers.set(name, value)
    }
  }

  return merged
}

function mergeClassIntoMethod(defaults: ClassSpec, spec: MethodSpec): MethodSpec {
  return {
    ...spec,
    path: joinPaths(defaults.path ?? '', spec.path),
    headers: mergeHeaders(defaults.headers, spec.headers),
    responseConverter: spec.responseConverter ?? defaults.responseConverter,
    requestBodyConverter: spec.requestBodyConverter ?? defaults.requestBodyConverter,
    responseHandler: spec.responseHandler ?? defaults.responseHandler,
    formURLEncoded: spec.formURLEncoded || defaults.formURLEncoded,
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
 * Builds API clients from classes decorated with `@API()`, all sharing this client's base URL,
 * transport, interceptors and call adapters. Make one with {@link FetchyBuilder}.
 */
export class FetchyClient {
  private readonly transport: Transport
  private closing: Promise<void> | undefined

  constructor(private readonly options: FetchyClientOptions) {
    this.transport = options.transportFactory.provide(options.baseURL)
  }

  /**
   * Releases the transport's resources, such as the connection pool `UndiciTransportFactory` opens, once
   * the requests already sent complete. Every API client this one created shares that transport. A
   * second call returns the same promise.
   */
  close(): Promise<void> {
    this.closing ??= this.transport.close?.() ?? Promise.resolve()
    return this.closing
  }

  /**
   * Closes the client, as {@link close} does, at the end of an `await using` block.
   */
  [Symbol.asyncDispose](): Promise<void> {
    return this.close()
  }

  /**
   * Builds a client from a class decorated with `@API()`, or from a subclass of one.
   *
   * The client is an instance of the class. It serves every operation the class and its base
   * classes declare, under the configuration they merge to: where a subclass and a base class both
   * set something, the subclass wins, and headers merge by name. Every operation is validated before
   * the class is constructed, so a class that fails validation never runs its constructor.
   *
   * A subclass method that overrides an operation without declaring one itself is an ordinary
   * override: it runs in place of the operation, and reaches it through `super`.
   *
   * A method operation lives on the class's prototype and finds its client through `this`, so it
   * composes with other method decorators and works through `super`. Called detached from its
   * client, it throws `ErrFetchyClientNotBuilt`. A field operation is bound to its client.
   *
   * Each call builds its own client: two clients of one class never share a request.
   *
   * @throws {@link ErrFetchyMissingAPIDecorator} when neither the class nor a base class carries `@API()`.
   * @throws {@link ErrFetchyEmptyClient} when neither the class nor its base classes declare an operation.
   * @throws {@link ErrFetchyInvalidRoute} when an operation's configuration is invalid.
   */
  create<T extends AnyCtor>(TargetAPI: T, ...args: ConstructorParameters<T>): InstanceType<T> {
    const operations = operationsOf(TargetAPI)
    const invokers: Invoker[] = []

    for (const { label, spec } of operations) {
      const responseConverter = spec.responseConverter ?? this.options.responseConverter ?? JSONResponseConverter

      invokers.push(
        buildInvoker(
          {
            baseURL: this.options.baseURL,
            transport: this.transport,
            interceptors: this.options.interceptors,
            responseConverter,
            callAdapterFactories: this.options.callAdapterFactories,
          },
          spec,
          label,
        ),
      )
    }

    const instance = new TargetAPI(...args) as InstanceType<T>

    // Defined, not assigned: defined symbol keys keep the instance's properties fast.
    for (let i = 0; i < operations.length; i++) {
      Object.defineProperty(instance, operations[i].key, { value: invokers[i] })
    }

    return instance
  }
}

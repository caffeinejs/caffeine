import { Binding, newBinding } from '../../binding.js'
import { Conditional } from '../../conditional.js'
import { ErrInvalidDecorator, ErrRepeatedInjectableConfiguration } from '../../errors.js'
import { Factory, AsyncFactory } from '../../factory.js'
import { Injection, InjectionDescriptor } from '../../injection.js'
import { Identifier, InjectionToken, NamedToken, keyStr } from '../../key.js'
import { PostResolutionInterceptor } from '../../post_resolution_interceptor.js'
import type { Scope } from '../../scope.js'
import { Ctor } from '../../types.js'
import { normalizeInjections, normalizeInjection } from '../util/index.js'

export class DecoratedBindingConfig {
  #profiles?: Set<Identifier>
  #scopeID?: NamedToken<Scope>
  #names?: Identifier[]
  #factory?: Factory<unknown> | AsyncFactory<unknown>
  #conditionals?: Conditional[]
  #key?: InjectionToken
  #dependencies?: InjectionDescriptor[]
  #type?: Function
  #primary?: boolean
  #lazy?: boolean
  #byPassPostProcessors?: boolean
  #labels?: symbol[]
  #interceptors?: PostResolutionInterceptor[]
  #tags?: Map<symbol, unknown>
  #configuration?: boolean
  #keysProvided?: InjectionToken[]
  #extend?: InjectionToken
  #postConstruct?: Identifier | ((value: any) => void)
  #preDestroy?: Identifier | ((value: any) => void | Promise<void>)
  #injectableProperties?: Map<Identifier, InjectionDescriptor<unknown>>
  #injectableMethods?: Map<Identifier, InjectionDescriptor<unknown>[]>
  #configuredBy?: string
  #source?: { ctor: Ctor; method: string | symbol }
  #fallback?: boolean
  #order?: number
  #async?: boolean
  #metadataMerged?: boolean

  constructor(key?: InjectionToken) {
    this.#key = key
  }

  get getProfiles(): Set<Identifier> | undefined {
    return this.#profiles
  }

  get scopeID(): NamedToken<Scope> | undefined {
    return this.#scopeID
  }

  get bindingKey(): InjectionToken | undefined {
    return this.#key
  }

  get isLazy(): boolean | undefined {
    return this.#lazy
  }

  get isPrimary(): boolean | undefined {
    return this.#primary
  }

  get getLabels(): symbol[] | undefined {
    return this.#labels
  }

  get getTags(): Map<symbol, unknown> | undefined {
    return this.#tags
  }

  get getConditionals(): Conditional[] | undefined {
    return this.#conditionals
  }

  get isFallback(): boolean | undefined {
    return this.#fallback
  }

  get isConfiguration(): boolean | undefined {
    return this.#configuration
  }

  get getKeysProvided(): InjectionToken[] | undefined {
    return this.#keysProvided
  }

  get getSource(): { ctor: Ctor; method: string | symbol } | undefined {
    return this.#source
  }

  profiles(profiles: Identifier | Identifier[]): this {
    this.#profiles ??= new Set()

    const incoming = Array.isArray(profiles) ? profiles : [profiles]
    const newly = new Set(incoming)
    for (const profile of newly) {
      this.#profiles.add(profile)
    }

    return this
  }

  scope(scopeID: NamedToken<Scope>): this {
    this.#scopeID = scopeID
    return this
  }

  async(async = true): this {
    this.#async = async
    return this
  }

  names(incoming?: Identifier | Identifier[]): this {
    if (!incoming) {
      return this
    }

    this.#names ??= new Array<Identifier>()

    const names = Array.isArray(incoming) ? incoming : [incoming]

    if (this.#names.some(value => names.includes(value))) {
      throw new ErrRepeatedInjectableConfiguration(
        `Found repeated names for binding "${keyStr(this.#key)}": ${names.map(x => keyStr(x)).join(', ')}`,
      )
    }

    this.#names.push(...names)

    return this
  }

  factory<T = unknown>(factory: Factory<T> | AsyncFactory<T>): this {
    this.#factory = factory
    return this
  }

  conditional(conditional: Conditional): this {
    this.#conditionals ??= new Array<Conditional>()
    this.#conditionals.unshift(conditional)
    return this
  }

  key(key: InjectionToken): this {
    this.#key = key
    return this
  }

  dependencies(deps: Injection[]): this {
    this.#dependencies = normalizeInjections(deps)
    return this
  }

  type(type?: Function): this {
    this.#type = type
    return this
  }

  primary(primary = true): this {
    this.#primary = primary
    return this
  }

  lazy(lazy = true): this {
    this.#lazy = lazy
    return this
  }

  byPassPostProcessors(byPass = true): this {
    this.#byPassPostProcessors = byPass
    return this
  }

  label(label: symbol): this {
    this.#labels ??= new Array<symbol>()
    this.#labels.push(label)
    return this
  }

  labels(labels: symbol[]): this {
    this.#labels ??= new Array<symbol>()
    this.#labels.push(...labels)
    return this
  }

  interceptor(interceptor: PostResolutionInterceptor): this {
    ;(this.#interceptors ??= []).push(interceptor)
    return this
  }

  tag(key: symbol, value: unknown): this {
    this.#tags ??= new Map()
    this.#tags = mergeTags(this.#tags, new Map([[key, value]]))
    return this
  }

  tags(tags: Map<symbol, unknown>): this {
    this.#tags ??= new Map()
    this.#tags = mergeTags(this.#tags, tags)
    return this
  }

  configuration(configuration = true): this {
    this.#configuration = configuration
    return this
  }

  keysProvided(keys: InjectionToken[]): this {
    this.#keysProvided = keys
    return this
  }

  extend(key: InjectionToken): this {
    this.#extend = key
    return this
  }

  postConstruct(postConstruct: Identifier | ((value: any) => void)): this {
    this.#postConstruct = postConstruct
    return this
  }

  preDestroy(preDestroy: Identifier | ((value: any) => void | Promise<void>)): this {
    this.#preDestroy = preDestroy
    return this
  }

  injectableProperty(name: Identifier, descriptor: Injection<unknown>): this {
    this.#injectableProperties ??= new Map()
    this.#injectableProperties.set(name, normalizeInjection(descriptor))
    return this
  }

  injectableProperties(properties: Map<Identifier, Injection<unknown>>): this {
    this.#injectableProperties = new Map(
      properties.entries().map(([name, descriptor]) => [name, normalizeInjection(descriptor)]),
    )
    return this
  }

  injectableMethod(name: Identifier, descriptors: Injection<unknown>[]): this {
    this.#injectableMethods ??= new Map()
    this.#injectableMethods.set(name, normalizeInjections(descriptors))
    return this
  }

  injectableMethods(methods: Map<Identifier, Injection<unknown>[]>): this {
    this.#injectableMethods = new Map(
      methods.entries().map(([name, descriptors]) => [name, normalizeInjections(descriptors)]),
    )
    return this
  }

  configuredBy(configuredBy: string): this {
    this.#configuredBy = configuredBy
    return this
  }

  source(ctor: Ctor, method: string | symbol): this {
    this.#source = { ctor, method }
    return this
  }

  fallback(fallback = true): this {
    this.#fallback = fallback
    return this
  }

  order(order: number): this {
    this.#order = order
    return this
  }

  asyncBean(value = true): this {
    this.#async = value
    return this
  }

  hasMetadataBeenMerged(): boolean {
    return this.#metadataMerged ?? false
  }

  mergeMetadata(metadata: MemberMetadata): this {
    if (this.#metadataMerged) {
      return this
    }

    this.#metadataMerged = true

    metadata.applyTo(this)

    return this
  }

  binding(): Binding {
    return newBinding({
      injections: this.#dependencies,
      injectableProperties: this.#injectableProperties,
      injectableMethods: this.#injectableMethods,
      interceptors: this.#interceptors,
      profiles: this.#profiles,
      scopeID: this.#scopeID,
      names: this.#names,
      factory: this.#factory,
      conditionals: this.#conditionals,
      keysProvided: this.#keysProvided,
      extend: this.#extend,
      primary: this.#primary,
      type: this.#type,
      configuredBy: this.#configuredBy,
      lazy: this.#lazy,
      byPassPostProcessors: this.#byPassPostProcessors,
      postConstruct:
        this.#postConstruct === undefined
          ? undefined
          : typeof this.#postConstruct === 'function'
            ? this.#postConstruct
            : (value: any) => (value as any)[this.#postConstruct as string | symbol]?.(),
      preDestroy:
        this.#preDestroy === undefined
          ? undefined
          : typeof this.#preDestroy === 'function'
            ? this.#preDestroy
            : (value: any) => (value as any)[this.#preDestroy as string | symbol]?.(),
      labels: this.#labels,
      tags: this.#tags,
      configuration: this.#configuration,
      internal: false,
      source: this.#source,
      fallback: this.#fallback,
      order: this.#order,
      async: this.#async,
      ctx: undefined,
    })
  }
}

export class MemberMetadata {
  #members?: Map<Identifier, DecoratedBindingConfig>
  #injectableProperties?: Map<Identifier, InjectionDescriptor<unknown>>
  #injectableMethods?: Map<Identifier, InjectionDescriptor<unknown>[]>
  #postConstruct?: string | symbol
  #preDestroy?: string | symbol

  get members(): Map<Identifier, DecoratedBindingConfig> | undefined {
    return this.#members
  }

  member(name: Identifier, config: DecoratedBindingConfig): this {
    ;(this.#members ??= new Map()).set(name, config)
    return this
  }

  memberFor(name: Identifier): DecoratedBindingConfig {
    this.#members ??= new Map()
    let member = this.#members.get(name)
    if (!member) {
      member = new DecoratedBindingConfig()
      this.#members.set(name, member)
    }

    return member
  }

  injectableProperty(name: Identifier, descriptor: Injection<unknown>): this {
    this.#injectableProperties ??= new Map()
    this.#injectableProperties.set(name, normalizeInjection(descriptor))
    return this
  }

  injectableMethod(name: Identifier, descriptors: Injection<unknown>[]): this {
    this.#injectableMethods ??= new Map()
    this.#injectableMethods.set(name, normalizeInjections(descriptors))
    return this
  }

  postConstruct(name: string | symbol): this {
    if (this.#postConstruct) {
      throw new ErrInvalidDecorator(
        `@PostConstruct is already defined on method "${String(this.#postConstruct)}": only 1 @PostConstruct is allowed per class`,
      )
    }

    this.#postConstruct = name
    return this
  }

  preDestroy(name: string | symbol): this {
    if (this.#preDestroy) {
      throw new ErrInvalidDecorator(
        `@PreDestroy is already defined on method "${String(this.#preDestroy)}": only 1 @PreDestroy is allowed per class`,
      )
    }

    this.#preDestroy = name
    return this
  }

  applyTo(config: DecoratedBindingConfig): void {
    if (this.#injectableProperties) {
      config.injectableProperties(this.#injectableProperties)
    }

    if (this.#injectableMethods) {
      config.injectableMethods(this.#injectableMethods)
    }

    if (this.#postConstruct) {
      config.postConstruct(this.#postConstruct)
    }

    if (this.#preDestroy) {
      config.preDestroy(this.#preDestroy)
    }
  }
}

function isPlainObject(v: unknown): v is Record<string | symbol, unknown> {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    !(v instanceof Map) &&
    !(v instanceof Set) &&
    Object.getPrototypeOf(v) === Object.prototype
  )
}

function mergeTags(base: Map<symbol, unknown>, override: Map<symbol, unknown>): Map<symbol, unknown> {
  if (base.size === 0 && override.size === 0) {
    return base
  }
  if (base.size === 0) {
    return new Map(override)
  }
  if (override.size === 0) {
    return new Map(base)
  }

  const result = new Map(base)

  for (const [k, v] of override) {
    if (!result.has(k)) {
      result.set(k, v)
      continue
    }

    const existing = result.get(k)

    if (Array.isArray(existing) && Array.isArray(v)) {
      result.set(k, [...v, ...existing])
    } else if (existing instanceof Set && v instanceof Set) {
      result.set(k, new Set([...v, ...existing]))
    } else if (existing instanceof Map && v instanceof Map) {
      result.set(k, new Map([...existing, ...v]))
    } else if (isPlainObject(existing) && isPlainObject(v)) {
      result.set(k, { ...existing, ...(v as object) })
    } else {
      result.set(k, v)
    }
  }

  return result
}

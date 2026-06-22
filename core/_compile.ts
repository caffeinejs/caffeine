import { Binding } from './binding.js'
import { Container } from './container_interface.js'
import { DeferredCtor } from './deferred_ctor.js'
import { ErrConfigurationBindingNotFound, ErrInvalidBinding } from './errors.js'
import { Factory, AsyncFactory } from './factory.js'
import { chainedFactory, scopedFactory, classFactory, configurationClassFactory } from './internal/core/factory/index.js'
import {
  propertyInjectorInterceptor,
  methodInjectorInterceptor,
  postConstructInterceptor,
  beforeInitInterceptor,
  afterInitInterceptor,
} from './internal/core/interceptor/index.js'
import { InjectionDescriptor } from './injection.js'
import { BuiltInResolvers, InjectionResolver, resolverFor } from './injection_resolver.js'
import { keyStr, Key, Identifier } from './key.js'
import { PostResolutionInterceptor } from './post_resolution_interceptor.js'
import { Scope, Scopes } from './scope.js'
import { Ctor } from './types.js'

export function compileDescriptorResolver(
  container: Container,
  key: Key,
  injection: InjectionDescriptor<unknown>,
  kind: 'constructor' | 'property' | 'method',
  member: Identifier,
  index: number,
): InjectionResolver {
  const resolverName
    = injection.resolver
      ?? (injection.key instanceof DeferredCtor ? BuiltInResolvers.DEFER : BuiltInResolvers.DEFAULT)

  return resolverFor(resolverName)({ container, key, descriptor: injection, kind, member, index })
}

export function compileInjectionResolvers(container: Container, key: Key, binding: Binding): void {
  if (binding.injections.length > 0) {
    binding.injectionResolvers = new Array(binding.injections.length)
    for (let i = 0; i < binding.injections.length; i++) {
      binding.injectionResolvers[i]
        = compileDescriptorResolver(container, key, binding.injections[i], 'constructor', '', i)
    }
  }

  for (const [prop, desc] of binding.injectableProperties) {
    binding.propertyResolvers.set(prop, compileDescriptorResolver(container, key, desc, 'property', prop as Identifier, -1))
  }

  for (const [method, specs] of binding.injectableMethods) {
    const resolvers = new Array<InjectionResolver>(specs.length)
    for (let i = 0; i < specs.length; i++) {
      resolvers[i] = compileDescriptorResolver(container, key, specs[i], 'method', method as Identifier, i)
    }

    binding.methodResolvers.set(method, resolvers)
  }
}

export function compileFactory<T>(
  container: Container,
  scopes: Map<Identifier, Scope>,
  key: Key<T>,
  binding: Binding<T>,
): void {
  const scopeId = binding.scopeId
  const scope = scopeId !== Scopes.TRANSIENT ? scopes.get(scopeId)! : undefined
  const ctor: Ctor | undefined
    = (binding.type as Ctor | undefined) ?? (typeof key === 'function' ? (key as Ctor) : undefined)

  let rawFactory: Factory<T> | AsyncFactory<T> | undefined
  if (binding.factory) {
    rawFactory = binding.factory
  } else if (binding.factoryCreator) {
    rawFactory = binding.factoryCreator(key, binding, container)
  } else {
    if (binding.source !== undefined) {
      const conf = container.getBinding(binding.source.ctor)
      if (conf === undefined) {
        throw new ErrConfigurationBindingNotFound(binding.source.ctor)
      }

      rawFactory = configurationClassFactory<T>(
        binding.source.ctor as Ctor<T>,
        binding.source.method,
        conf,
      )
    } else {
      if (ctor !== undefined) {
        rawFactory = classFactory<T>(ctor as Ctor<T>, binding.injectionResolvers)
      }
    }
  }

  if (rawFactory === undefined || rawFactory === null) {
    throw new ErrInvalidBinding(`Could not determine a factory for key: ${keyStr(key)}`)
  }

  const chainableFactory = rawFactory as Factory<T>
  const chain: PostResolutionInterceptor<T>[] = []

  if (!binding.async) {
    if (binding.injectableProperties.size > 0) {
      chain.push(propertyInjectorInterceptor<T>())
    }
    if (binding.injectableMethods.size > 0) {
      chain.push(methodInjectorInterceptor<T>())
    }
  }

  for (const interceptor of binding.interceptors) {
    chain.push(interceptor)
  }

  if (!binding.byPassPostProcessors) {
    for (const postProcessor of container.postProcessors) {
      chain.push(beforeInitInterceptor<T>(postProcessor))
    }
  }

  if (binding.postConstruct) {
    chain.push(postConstructInterceptor<T>())
  }

  if (!binding.byPassPostProcessors) {
    for (const postProcessor of container.postProcessors) {
      chain.push(afterInitInterceptor<T>(postProcessor))
    }
  }

  let factory: Factory<T>
  if (chain.length === 0) {
    factory = chainableFactory
  } else if (binding.async) {
    const base = chainableFactory
    factory = ctx =>
      (base(ctx) as unknown as Promise<T>).then(instance =>
        chain.reduce((v, fn) => fn(ctx, v) as T, instance),
      ) as unknown as T
  } else {
    factory = chainedFactory(chainableFactory, chain)
  }

  binding.unscopedFactory = factory
  binding.factory = scopeId === Scopes.TRANSIENT ? factory : scopedFactory(scope!, factory)
  binding.ctx = { container, key, binding }

  scope?.configure(binding)
}

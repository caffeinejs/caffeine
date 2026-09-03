import { ErrInvalidDecorator, ErrScopeMismatchInConfiguration } from '../errors.js'
import { Injection } from '../injection.js'
import { isNil } from '../internal/util/assert/index.js'
import { solutions } from '../internal/util/errutil/index.js'
import { InjectionToken } from '../key.js'
import { Ctor } from '../types.js'
import { Provides } from './provides.js'
import { addProvidedBindings, defineInjectable, getInjectionMetadata } from './registrar/index.js'
import { DecoratedBindingConfig } from './registrar/spec.js'
import { normalizeInjections } from './util/index.js'

/**
 * Marks a class as a configuration source. Methods decorated with `@Provides` define factory bindings.
 *
 * @param injections - Optional constructor injections.
 *
 * @example
 * ```ts
 * @Configuration()
 * class AppConfig {
 *   @Provides(DataSource)
 *   dataSource(): DataSource {
 *     return new DataSource()
 *   }
 * }
 * ```
 */
export function Configuration(): <TFunction extends Ctor>(target: TFunction, context: ClassDecoratorContext) => void
export function Configuration(
  injections: Injection[],
): <TFunction extends Ctor>(target: TFunction, context: ClassDecoratorContext) => void
export function Configuration<T>(injections?: Injection[]) {
  return function <TFunction extends Ctor>(target: TFunction, context: ClassDecoratorContext) {
    const deps = injections ?? []
    const metadata = getInjectionMetadata(context.metadata)
    const members = metadata.members ?? new Map()
    const configurations = Array.from(members.entries()).map(([_, options]) => options)
    const keys = configurations.map(x => x.bindingKey).filter((k): k is InjectionToken => k !== undefined)

    const classBinding = defineInjectable<T>(context.metadata, target, config =>
      config.dependencies(normalizeInjections(deps)).configuration(true).keysProvided(keys),
    )

    const effectiveProfiles =
      classBinding.getProfiles && classBinding.getProfiles.size > 0 ? classBinding.getProfiles : undefined

    for (const [method, factory] of members) {
      if (!isNil(classBinding.scopeID) && !isNil(factory.scopeID) && classBinding.scopeID !== factory.scopeID) {
        throw new ErrScopeMismatchInConfiguration(target.name, String(method), classBinding.scopeID!, factory.scopeID!)
      }

      if (factory.bindingKey === undefined) {
        throw new ErrInvalidDecorator(
          `Cannot determine injection key for injectable on method "${String(method)}" at class "${target.name}"` +
            solutions(`- Ensure the method "${String(method)}" is decorated with '@${Provides.name}'`),
        )
      }

      const fb = factory.binding()

      const factoryConfig = new DecoratedBindingConfig(factory.bindingKey)
        .dependencies(fb.injections)
        .configuration(true)
        .source(target as unknown as Ctor, method)
        .configuredBy(`${target.name}/${String(method)}`)

      if (effectiveProfiles) {
        factoryConfig.profiles([...effectiveProfiles])
      }

      const lazy = isNil(classBinding.isLazy) ? factory.isLazy : classBinding.isLazy
      if (lazy !== undefined) {
        factoryConfig.lazy(lazy)
      }

      const primary = isNil(classBinding.isPrimary) ? factory.isPrimary : classBinding.isPrimary
      if (primary !== undefined) {
        factoryConfig.primary(primary)
      }

      const scopeID = isNil(classBinding.scopeID) ? factory.scopeID : classBinding.scopeID
      if (scopeID !== undefined) {
        factoryConfig.scope(scopeID)
      }

      for (const c of fb.conditionals.slice().reverse()) {
        factoryConfig.conditional(c)
      }
      if (fb.names.length > 0) {
        factoryConfig.names(fb.names)
      }
      if (fb.labels.length > 0) {
        factoryConfig.labels(fb.labels)
      }
      if (fb.tags.size > 0) {
        factoryConfig.tags(new Map(fb.tags))
      }

      const type = fb.type ?? (typeof factory.bindingKey === 'function' ? (factory.bindingKey as Function) : undefined)
      if (type) {
        factoryConfig.type(type)
      }
      if (fb.byPassPostProcessors !== undefined) {
        factoryConfig.byPassPostProcessors(fb.byPassPostProcessors)
      }
      for (const i of fb.interceptors) {
        factoryConfig.interceptor(i)
      }
      if (fb.fallback !== undefined) {
        factoryConfig.fallback(fb.fallback)
      }
      if (fb.async !== undefined) {
        factoryConfig.async(fb.async)
      }
      if (fb.preDestroy !== undefined) {
        factoryConfig.preDestroy(fb.preDestroy)
      }

      addProvidedBindings(factory.bindingKey, factoryConfig)
    }
  }
}

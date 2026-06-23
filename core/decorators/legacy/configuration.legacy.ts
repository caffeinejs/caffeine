import { Injection } from '../../injection.js'
import { Ctor } from '../../types.js'
import { ErrInvalidDecorator, ErrScopeMismatchInConfiguration } from '../../errors.js'
import { solutions } from '../../internal/util/errutil/index.js'
import { Key } from '../../key.js'
import { isNil } from '../../internal/util/assert/index.js'
import {
  addProvidedBindings,
  defineInjectable,
  getLegacyInjectionMetadata,
} from '../registrar/index.js'
import { DecoratedBindingConfig } from '../registrar/spec.js'
import { normalizeInjections } from '../util/index.js'
import { Provides } from './provides.legacy.js'

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
 *
 * @remarks
 * Requires `experimentalDecorators: true` in `tsconfig.json`.
 */
export function Configuration(): (target: Function) => void
export function Configuration(injections: Injection[]): (target: Function) => void
export function Configuration<T>(injections?: Injection[]) {
  return function (target: Function) {
    const deps = injections ?? []
    const metadata = getLegacyInjectionMetadata(target)
    const members = metadata.members ?? new Map()
    const keys = Array.from(members.values())
      .map(x => x.bindingKey)
      .filter((k): k is Key => k !== undefined)

    const classBinding = defineInjectable<T>(target, target as Key<T>,
      config => config
        .dependencies(normalizeInjections(deps))
        .configuration(true)
        .keysProvided(keys))

    const effectiveProfiles = (classBinding.getProfiles?.size ?? 0) > 0 ? classBinding.getProfiles : undefined

    for (const [method, factory] of members) {
      if (!isNil(classBinding.scopeId) && !isNil(factory.scopeId) && classBinding.scopeId !== factory.scopeId) {
        throw new ErrScopeMismatchInConfiguration(
          (target as Ctor).name,
          String(method),
          classBinding.scopeId!,
          factory.scopeId!,
        )
      }

      if (factory.bindingKey === undefined) {
        throw new ErrInvalidDecorator(
          `Cannot determine injection key for injectable on method "${String(method)}" at class "${(target as Ctor).name}"`
          + solutions(`- Ensure the method "${String(method)}" is decorated with '@${Provides.name}'`),
        )
      }

      const fb = factory.binding()

      const factoryConfig = new DecoratedBindingConfig(factory.bindingKey)
        .dependencies(fb.injections)
        .configuration(true)
        .source(target as unknown as Ctor, method)
        .configuredBy(`${(target as Ctor).name}/${String(method)}`)

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

      const scopeId = isNil(classBinding.scopeId) ? factory.scopeId : classBinding.scopeId
      if (scopeId !== undefined) {
        factoryConfig.scope(scopeId)
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

      const type = fb.type ?? (typeof factory.bindingKey === 'function' ? factory.bindingKey as Function : undefined)
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

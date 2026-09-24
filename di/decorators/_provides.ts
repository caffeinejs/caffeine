import { ErrInvalidDecorator } from '../errors.js'
import { Injection } from '../injection.js'
import { isNil } from '../internal/util/assert/index.js'
import { InjectionToken, NamedToken, isNamedKey } from '../key.js'
import { Configuration } from './configuration.js'
import { extendMemberInjectableAttributes } from './registrar/index.js'
import { normalizeInjections } from './util/index.js'

/**
 * The body both `@Provides` and `@ProvidesAsync` run. They differ only in the factory signature they accept
 * and in whether the binding is awaited, so the argument handling lives here rather than in two copies.
 */
export function defineProvides(
  decoratorName: string,
  isAsync: boolean,
  key: InjectionToken<any>,
  nameOrDependencies?: Injection[] | NamedToken<any>,
  dependencies?: Injection[],
) {
  return function (target: Function, context: DecoratorContext): void {
    if (context.kind === 'class') {
      throw new ErrInvalidDecorator(
        `Cannot use @${decoratorName} on a class "${context.name}": use it on a method inside a @${Configuration.name} class`,
      )
    }

    const deps = Array.isArray(nameOrDependencies) ? (nameOrDependencies as Injection[]) : (dependencies ?? [])
    const name = isNil(nameOrDependencies)
      ? undefined
      : isNamedKey(nameOrDependencies)
        ? (nameOrDependencies as InjectionToken)
        : undefined

    if (isNil(key)) {
      throw new ErrInvalidDecorator(
        `@${decoratorName} on a @${Configuration.name} method must receive a valid key: received "${String(key)}" on method "${String(context.name)}" of class "${target.constructor.name}"`,
      )
    }

    const type = typeof key === 'function' ? key : undefined
    const actualKey = typeof name === 'undefined' ? key : name

    extendMemberInjectableAttributes(context.metadata, context.name, config => {
      config.dependencies(normalizeInjections(deps)).key(actualKey).type(type)

      if (isAsync) {
        config.async()
      }
    })
  }
}

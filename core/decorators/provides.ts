import { Injection } from '../injection.js'
import { Key, Identifier, isNamedKey } from '../key.js'
import { isNil } from '../internal/util/assert/index.js'
import { ErrInvalidDecorator } from '../errors.js'
import { extendMemberInjectableAttributes } from './registrar/index.js'
import { normalizeInjections } from './util/index.js'
import { Configuration } from './configuration.js'

/**
 * Marks a method inside a `@Configuration` class as a factory that provides a binding.
 *
 * @param key - The binding key to register.
 * @param dependencies - Optional method-level injection overrides.
 *
 * @example
 * ```ts
 * @Configuration()
 * class AppConfig {
 *   @Provides(HttpClient)
 *   httpClient(): HttpClient {
 *     return new HttpClient({ timeout: 5000 })
 *   }
 * }
 * ```
 */
export function Provides(key: Key): (target: Function, context: ClassMethodDecoratorContext) => void
export function Provides(
  key: Key,
  dependencies?: Injection[],
): (target: Function, context: ClassMethodDecoratorContext) => void
export function Provides(
  key: Key,
  name?: Identifier,
  dependencies?: Injection[],
): (target: Function, context: ClassMethodDecoratorContext) => void
export function Provides(key: Key, nameOrDependencies?: Injection[] | Identifier) {
  return function (target: Function, context: DecoratorContext) {
    if (context.kind === 'class') {
      throw new ErrInvalidDecorator(
        `Cannot use @${Provides.name} on a class "${context.name}": use it on a method inside a @${Configuration.name} class`,
      )
    }

    const deps = Array.isArray(nameOrDependencies) ? (nameOrDependencies as Injection[]) : []
    const name = isNil(nameOrDependencies)
      ? undefined
      : isNamedKey(nameOrDependencies)
        ? (nameOrDependencies as Key)
        : undefined

    if (isNil(key)) {
      throw new ErrInvalidDecorator(
        `@${Provides.name} on a @${Configuration.name} method must receive a valid key: received "${String(key)}" on method "${String(context.name)}" of class "${target.constructor.name}"`,
      )
    }

    const type = typeof key === 'function' ? key : undefined
    const actualKey = typeof name === 'undefined' ? key : name

    extendMemberInjectableAttributes(context.metadata, context.name,
      config => config
        .dependencies(normalizeInjections(deps))
        .key(actualKey)
        .type(type),
    )
  }
}

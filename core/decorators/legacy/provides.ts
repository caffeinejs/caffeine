import { Injection } from '../../injection.js'
import { Key, Identifier, isNamedKey } from '../../key.js'
import { isNil } from '../../internal/util/assert/index.js'
import { ErrInvalidDecorator } from '../../errors.js'
import { extendMemberInjectableAttributes } from '../registrar/index.js'
import { normalizeInjections } from '../util/index.js'
import { idfy } from '../registrar/types.js'
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
 *
 * @remarks
 * Requires `experimentalDecorators: true` in `tsconfig.json`.
 */
export function Provides(
  key: Key,
): (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) => void
export function Provides(
  key: Key,
  dependencies?: Injection[],
): (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) => void
export function Provides(
  key: Key,
  name?: Identifier,
  dependencies?: Injection[],
): (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) => void
export function Provides(key: Key, nameOrDependencies?: Injection[] | Identifier) {
  return function (target: object, propertyKey: string | symbol, _descriptor: PropertyDescriptor) {
    const deps = Array.isArray(nameOrDependencies) ? (nameOrDependencies as Injection[]) : []
    const name = isNil(nameOrDependencies)
      ? undefined
      : isNamedKey(nameOrDependencies)
        ? (nameOrDependencies as Key)
        : undefined

    if (isNil(key)) {
      throw new ErrInvalidDecorator(
        `@${Provides.name} on a @${Configuration.name} method must receive a valid key: received "${String(key)}" on method "${String(propertyKey)}"`,
      )
    }

    const type = typeof key === 'function' ? key : undefined
    const actualKey = typeof name === 'undefined' ? key : name

    extendMemberInjectableAttributes(idfy(target), propertyKey,
      config => config
        .dependencies(normalizeInjections(deps))
        .key(actualKey)
        .type(type))
  }
}

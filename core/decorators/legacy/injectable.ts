import { ErrInvalidDecorator } from '../../errors.js'
import { isNamedKey, Identifier, Key } from '../../key.js'
import { Injection } from '../../injection.js'
import { normalizeInjections } from '../util/index.js'
import { buildLegacyConstructorDeps, defineInjectable } from '../registrar/index.js'
import { Extends } from './extends.js'

/**
 * Marks a class as an injectable component, registering it in the container.
 *
 * Pass a named key (string or symbol) to bind by name instead of type.
 * For abstract-type binding use `@Extends` instead.
 *
 * @param key - Optional named identifier.
 * @param dependencies - Optional constructor injections.
 *
 * @example
 * ```ts
 * @Injectable()
 * class UserService {}
 *
 * @Injectable('userService')
 * class UserService {}
 * ```
 *
 * @remarks
 * Requires `experimentalDecorators: true` in `tsconfig.json`.
 */
export function Injectable(): (target: Function) => void
export function Injectable(key: Identifier): (target: Function) => void
export function Injectable(dependencies: Injection[]): (target: Function) => void
export function Injectable(key: Identifier, dependencies: Injection[]): (target: Function) => void
export function Injectable<T>(keyOrDependencies?: Key | Injection[], dependencies?: Injection[]) {
  const key = keyOrDependencies !== undefined && !Array.isArray(keyOrDependencies) ? keyOrDependencies : undefined
  const explicitDeps = Array.isArray(keyOrDependencies) ? keyOrDependencies : dependencies ?? []

  if (key !== undefined && !isNamedKey(key)) {
    throw new ErrInvalidDecorator(
      `@${Injectable.name} only accepts a string or symbol as a named key: received "${typeof key}" on the decorated class.\n`
      + `To bind a this to an abstract class a key, use @${Extends.name}(Base) on the concrete class instead`,
    )
  }

  return (target: Function) => {
    const normalizedExplicit = normalizeInjections(explicitDeps)
    const deps = buildLegacyConstructorDeps(target, normalizedExplicit)

    defineInjectable<T>(target, target as Key<T>,
      config =>
        config
          .type(target)
          .dependencies(deps)
          .names(key))
  }
}

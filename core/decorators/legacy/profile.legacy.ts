import { Ctor } from '../../types.js'
import { Identifier } from '../../key.js'
import { extendInjectableAttributes, extendMemberInjectableAttributes } from '../registrar/index.js'

/**
 * Restricts registration to specific profiles. The binding is only active when one of
 * the given profiles is enabled in the container.
 *
 * @param profile - First profile name (required).
 * @param profiles - Additional profile names.
 *
 * @example
 * ```ts
 * @Profile('development')
 * @Injectable()
 * class MockEmailService implements EmailService {}
 * ```
 *
 * @remarks
 * Requires `experimentalDecorators: true` in `tsconfig.json`.
 */
export function Profile(
  profile: Identifier,
  ...profiles: Identifier[]
): (target: object | Function, propertyKey?: string | symbol) => void {
  return (target: object | Function, propertyKey?: string | symbol) => {
    if (typeof target === 'function' && propertyKey === undefined) {
      extendInjectableAttributes(target, target as Ctor, config => config.profiles([profile, ...profiles]))
    } else {
      extendMemberInjectableAttributes(target as object, propertyKey!,
        config => config.profiles([profile, ...profiles]))
    }
  }
}

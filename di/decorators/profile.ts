import { notNil } from '../internal/util/assert/not_nil.js'
import { Ctor } from '../types.js'
import { extendInjectableAttributes } from './registrar/index.js'

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
 */
export function Profile(profile: string, ...profiles: string[]) {
  notNil(profile, `@${Profile.name}(): parameter profile is required.`)

  return (target: Ctor, context: ClassDecoratorContext) => {
    extendInjectableAttributes(context.metadata, target, config => config.profiles([profile, ...profiles]))
  }
}

import { notNil } from '../internal/util/assert/not_nil.js'
import { Identifier } from '../key.js'
import { extendInjectableAttributes, extendMemberInjectableAttributes } from './registrar/index.js'
import { defineClassOrMemberDecorator } from './util/index.js'

/**
 * Registers the component with a custom scope identified by `scopeId`.
 *
 * Sets the scope that controls instance sharing for this component.
 * Note that custom scope implementations must be registered before use.
 *
 * @param scopeId - Identifier of the scope.
 *
 * @example
 * ```ts
 * @Lifetime(Scopes.REFRESH)
 * @Injectable()
 * class Service {}
 * ```
 */
export function Lifetime(scopeId: Identifier) {
  notNil(scopeId, `@${Lifetime.name}(): parameter scopeId is required.`)

  return defineClassOrMemberDecorator(
    (target, ctx) => extendInjectableAttributes(ctx.metadata, target, config => config.scope(scopeId)),
    ctx => extendMemberInjectableAttributes(ctx.metadata, ctx.name!, config => config.scope(scopeId)),
  )
}

import { notNil } from '../internal/util/assert/not_nil.js'
import { NamedToken } from '../key.js'
import type { Scope } from '../scope.js'
import { extendInjectableAttributes, extendMemberInjectableAttributes } from './registrar/index.js'
import { defineClassOrMemberDecorator } from './util/index.js'

/**
 * Registers the component with a custom scope identified by `scopeID`.
 *
 * Sets the scope that controls instance sharing for this component.
 * Note that custom scope implementations must be registered before use.
 *
 * @param scopeID - Token identifying the scope, minted with `token<Scope>(...)`.
 *
 * @example
 * ```ts
 * @Lifetime(Scopes.REFRESH)
 * @Injectable()
 * class Service {}
 * ```
 */
export function Lifetime(scopeID: NamedToken<Scope>) {
  notNil(scopeID, `@${Lifetime.name}(): parameter scopeID is required.`)

  return defineClassOrMemberDecorator(
    (target, ctx) => extendInjectableAttributes(ctx.metadata, target, config => config.scope(scopeID)),
    ctx => extendMemberInjectableAttributes(ctx.metadata, ctx.name!, config => config.scope(scopeID)),
  )
}

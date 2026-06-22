import { extendInjectableAttributes, extendMemberInjectableAttributes } from './registrar/index.js'
import { defineClassOrMemberDecorator } from './util/index.js'

/**
 * Marks a binding as the preferred candidate when multiple implementations qualify for injection.
 *
 * @example
 * ```ts
 *
 * @Injectable()
 * class NoopUserRepo implements UserRepo { }
 *
 * @Primary()
 * @Injectable()
 * class PostgresUserRepo implements UserRepo {}
 *
 * @Injectable([UserRepo])
 * class Controller {
 *   constructor(readonly userRepo: UserRepo) {} // will inject PostgresUserRepo
 * }
 * ```
 */
export function Primary() {
  return defineClassOrMemberDecorator(
    (target, ctx) => extendInjectableAttributes(ctx.metadata, target, config => config.primary()),
    ctx => extendMemberInjectableAttributes(ctx.metadata, ctx.name!, config => config.primary()),
  )
}

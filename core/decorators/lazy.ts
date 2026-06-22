import { extendInjectableAttributes, extendMemberInjectableAttributes } from './registrar/index.js'
import { defineClassOrMemberDecorator } from './util/index.js'

/**
 * Defers instantiation of the component until it is first accessed.
 *
 * @param lazy - Pass `false` to disable lazy loading. Defaults to `true`.
 *
 * @example
 * ```ts
 * @Lazy()
 * @Injectable()
 * class HeavyService {}
 * ```
 */
export function Lazy(lazy = true) {
  return defineClassOrMemberDecorator(
    (target, ctx) => extendInjectableAttributes(ctx.metadata, target, config => config.lazy(lazy)),
    ctx => extendMemberInjectableAttributes(ctx.metadata, ctx.name!, config => config.lazy(lazy)),
  )
}

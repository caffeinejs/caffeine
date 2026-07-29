import { extendInjectableAttributes, extendMemberInjectableAttributes } from './registrar/index.js'
import { defineClassOrMemberDecorator } from './util/index.js'

/**
 * Marks a binding as the last-resort candidate, used only when no other binding qualifies.
 *
 * @example
 * ```ts
 * @Fallback()
 * @Injectable()
 * class NoopLogger implements Logger {}
 * ```
 */
export function Fallback() {
  return defineClassOrMemberDecorator(
    (target, ctx) => extendInjectableAttributes(ctx.metadata, target, config => config.fallback()),
    ctx => extendMemberInjectableAttributes(ctx.metadata, ctx.name!, config => config.fallback()),
  )
}

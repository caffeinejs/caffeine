import { type ConditionHelpers, type Conditions, toConditions } from '../conditional.js'
import { ErrInvalidDecorator } from '../errors.js'
import { extendMemberInjectableAttributes, extendInjectableAttributes } from './registrar/index.js'
import { defineClassOrMemberDecorator } from './util/index.js'

/**
 * Registers the component only when its conditions pass. They are decided when the container compiles, and every
 * condition of every `@Conditional` on the component must pass.
 *
 * Takes conditions built with `$cond`, or a callback handed `$cond` that returns them. The callback runs once, when
 * the decorator is applied.
 *
 * @throws {@link ErrInvalidDecorator} when given anything but conditions
 *
 * @example
 * ```ts
 * @Conditional(c => c.missing(Cache))
 * @Injectable()
 * @Extends()
 * class InMemoryCache extends Cache {}
 *
 * @Conditional<AppConfig>(c => [c.present(RedisClient), c.config(cfg => cfg.cache.kind === 'redis')])
 * @Injectable([RedisClient])
 * @Extends()
 * class RedisCache extends Cache {}
 * ```
 */
export function Conditional<C = unknown>(conditions: Conditions | ((cond: ConditionHelpers<C>) => Conditions)) {
  const list = toConditions(
    conditions,
    (reason, options) => new ErrInvalidDecorator(`Cannot apply @${Conditional.name}(): ${reason}`, options),
  )

  return defineClassOrMemberDecorator(
    (target, ctx) => extendInjectableAttributes(ctx.metadata, target, config => config.conditional(list)),
    ctx => extendMemberInjectableAttributes(ctx.metadata, ctx.name!, config => config.conditional(list)),
  )
}

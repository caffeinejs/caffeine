import { conditionOf, type Condition, type ConditionHelpers } from '../conditional.js'
import { ErrInvalidDecorator } from '../errors.js'
import { extendMemberInjectableAttributes, extendInjectableAttributes } from './registrar/index.js'
import { defineClassOrMemberDecorator } from './util/index.js'

/**
 * Registers the component only when the condition passes. The container decides it once, when it compiles; until
 * then the component is not registered.
 *
 * Stacked, every condition must pass, the top-most first. On a `@Configuration` class, a condition that fails also
 * skips every `@Provides` method of the class. Once it passes, the binding never replaces another binding of its key:
 * `init()` throws `ErrRepeatedInjectableConfiguration` instead, and `rebind()` is what replaces a decorated binding.
 *
 * @param condition - A condition built with {@link $cond}, or a callback handed the same builders. The callback runs
 *   once, when the class is decorated.
 *
 * @throws {@link ErrInvalidDecorator} when handed anything else, a predicate included
 *
 * @example
 * ```ts
 * @Conditional(c => c.missing(Cache))
 * @Injectable()
 * @Extends()
 * class MemoryCache extends Cache {}
 * ```
 */
export function Conditional<T>(condition: Condition | ((c: ConditionHelpers) => Condition)) {
  return defineClassOrMemberDecorator(
    (target, ctx) => {
      const resolved = conditionOf(
        condition,
        reason => new ErrInvalidDecorator(`Cannot apply @${Conditional.name} to "${target.name}": ${reason}`),
      )

      extendInjectableAttributes<T>(ctx.metadata, target, config => config.conditional(resolved))
    },
    ctx => {
      const resolved = conditionOf(
        condition,
        reason =>
          new ErrInvalidDecorator(`Cannot apply @${Conditional.name} to member "${String(ctx.name)}": ${reason}`),
      )

      extendMemberInjectableAttributes(ctx.metadata, ctx.name!, config => config.conditional(resolved))
    },
  )
}

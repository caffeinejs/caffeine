import { conditionOf, type Condition, type ConditionHelpers } from '../conditional.js'
import { ErrInvalidDecorator } from '../errors.js'
import { extendMemberInjectableAttributes, extendInjectableAttributes } from './registrar/index.js'
import { defineClassOrMemberDecorator } from './util/index.js'

/**
 * Registers the component only when the condition passes.
 *
 * The container decides it once, when it compiles, after every binding that could answer to a key the condition
 * checks. Until then the component is not registered at all. Stacked, every condition must pass. On a
 * `@Configuration` class, a condition that fails skips every `@Provides` method of the class too.
 *
 * @param condition - A condition built with {@link $cond}, or a callback handed the same helpers. The callback runs
 *   once, when the class is decorated.
 *
 * @throws {@link ErrInvalidDecorator} when handed neither, or a callback that does not return a condition
 *
 * @example
 * ```ts
 * @Conditional(c => c.missing(Cache))
 * @Injectable()
 * @Extends()
 * class MemoryCache extends Cache {}
 * ```
 */
export function Conditional<C = unknown>(condition: Condition | ((c: ConditionHelpers<C>) => Condition)) {
  const resolved = conditionOf(
    condition,
    reason => new ErrInvalidDecorator(`Cannot apply @${Conditional.name}: ${reason}`),
  )

  return defineClassOrMemberDecorator(
    (target, ctx) => extendInjectableAttributes(ctx.metadata, target, config => config.conditional(resolved)),
    ctx => extendMemberInjectableAttributes(ctx.metadata, ctx.name!, config => config.conditional(resolved)),
  )
}

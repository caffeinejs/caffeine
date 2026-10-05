import { Conditional } from '../conditional.js'
import { ErrInvalidDecorator } from '../errors.js'
import { notNil } from '../internal/util/assert/not_nil.js'
import { extendMemberInjectableAttributes, extendInjectableAttributes } from './registrar/index.js'
import { defineClassOrMemberDecorator } from './util/index.js'

/**
 * Registers the component conditionally. The predicate is evaluated at container
 * initialization; the binding is skipped if it returns `false`.
 *
 * @param conditional - Predicate receiving the resolution context.
 *
 * @example
 * ```ts
 * @ConditionalOn(ctx => ctx.container.has(FeatureFlags))
 * @Injectable()
 * class ExperimentalService {}
 * ```
 */
export function ConditionalOn<T>(conditional: Conditional) {
  notNil(conditional, `@${ConditionalOn.name}(): parameter conditional is required.`)
  if (typeof conditional !== 'function') {
    throw new ErrInvalidDecorator(`@${ConditionalOn.name}(): parameter conditional must be a function`)
  }

  return defineClassOrMemberDecorator(
    (target, ctx) => extendInjectableAttributes<T>(ctx.metadata, target, config => config.conditional(conditional)),
    ctx => extendMemberInjectableAttributes(ctx.metadata, ctx.name!, config => config.conditional(conditional)),
  )
}

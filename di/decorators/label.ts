import { notNil } from '../internal/util/assert/not_nil.js'
import { extendInjectableAttributes, extendMemberInjectableAttributes } from './registrar/index.js'
import { defineClassOrMemberDecorator } from './util/index.js'

/**
 * Attaches one or more symbol labels to a binding.
 * Labels are dedicated for lib/framework builders. Thought the container provides means to resolve bindings by labels,
 * it is no the recommended way to typical dependency injection use cases.
 *
 * @param label - First label symbol (required).
 * @param labels - Additional label symbols.
 *
 * @example
 * ```ts
 * const PLUGIN = Symbol('plugin')
 *
 * @Label(PLUGIN)
 * @Injectable()
 * class AuthPlugin {}
 * ```
 */
export function Label(label: symbol, ...labels: symbol[]) {
  notNil(label, `@${Label.name}(): parameter label is required.`)

  const lbls = [label, ...labels]

  return defineClassOrMemberDecorator(
    (target, ctx) => extendInjectableAttributes(ctx.metadata, target, config => config.labels(lbls)),
    ctx => extendMemberInjectableAttributes(ctx.metadata, ctx.name!, config => config.labels(lbls)),
  )
}

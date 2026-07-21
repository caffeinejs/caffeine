import { ErrMissingInjectionKey } from '../../../errors.js'
import { solutions } from '../../util/errutil/index.js'
import { InjectionResolverFactory } from '../../../injection_resolver.js'
import { TypedKey } from '../../../key.js'
import { excludeSelf } from './_binding_util.js'
import { describeContext } from './_fmt.js'

export const orderedFactory: InjectionResolverFactory = ctx => {
  if (!ctx.descriptor.key) {
    throw new ErrMissingInjectionKey(
      `${describeContext(ctx)}: no injection key provided`
      + solutions(
        `- Provide an injection key`,
        `- For circular dependencies, use ordered(defer(() => key)) to defer resolution`,
      ),
    )
  }

  const key = ctx.descriptor.key as TypedKey<unknown>
  const bindings = excludeSelf(ctx.container.getBindings(key), ctx.key!, ctx.descriptor.key!, ctx.container)
  const sorted = [...bindings].sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity))

  return () => {
    const results = new Array<unknown>(sorted.length)

    for (let i = 0; i < sorted.length; i++) {
      results[i] = sorted[i].factory(sorted[i].ctx!)
    }

    return results
  }
}

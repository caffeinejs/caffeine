import { ErrMissingInjectionKey, ErrNoResolutionForKey } from '../../../errors.js'
import { solutions } from '../../util/errutil/index.js'
import { allOf, defer, optional } from '../../../injection.js'
import { InjectionResolverFactory } from '../../../injection_resolver.js'
import { TypedKey, keyStr } from '../../../key.js'
import { excludeSelf, uniqueBindingOrThrow } from './_binding_util.js'
import { describeContext } from './_fmt.js'

export const standardFactory: InjectionResolverFactory = ctx => {
  if (ctx.descriptor.multiple) {
    return multipleFactory(ctx)
  }

  if (!ctx.descriptor.key) {
    throw new ErrMissingInjectionKey(
      `${describeContext(ctx)}: no injection key provided`
      + solutions(
        `- Provide an injection key`,
        `- For circular dependencies, use ${defer.name}(() => key) to defer resolution`,
      ),
    )
  }

  const dep = uniqueBindingOrThrow(ctx, ctx.descriptor.key as TypedKey<unknown>)
  if (!dep) {
    if (ctx.descriptor.optional) {
      return () => undefined as any
    }

    throw new ErrNoResolutionForKey(
      `${describeContext(ctx)}: no binding registered for key "${keyStr(ctx.descriptor.key)}"`
      + solutions(
        `- Register a binding for key "${keyStr(ctx.descriptor.key)}"`,
        `- If the dependency is optional, use ${optional.name}(key)`,
      ),
    )
  }

  return () => dep.factory(dep.ctx!)
}

const multipleFactory: InjectionResolverFactory = ctx => {
  if (!ctx.descriptor.key) {
    throw new ErrMissingInjectionKey(
      `${describeContext(ctx)}: no injection key provided`
      + solutions(
        `- Provide an injection key`,
        `- For circular dependencies, use ${allOf.name}(${defer.name}(() => key)) to defer resolution`,
      ),
    )
  }

  const key = ctx.descriptor.key as TypedKey<unknown>
  const bindings = excludeSelf(ctx.container.getBindings(key), ctx.key!, ctx.descriptor.key!, ctx.container)

  return () => {
    const results = new Array<unknown>(bindings.length)

    for (let i = 0; i < bindings.length; i++) {
      results[i] = bindings[i].factory(bindings[i].ctx!)
    }

    return results
  }
}

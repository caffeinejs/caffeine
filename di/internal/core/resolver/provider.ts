import { DeferredCtor } from '../../../deferred_ctor.js'
import { ErrMissingInjectionKey, ErrNoResolutionForKey } from '../../../errors.js'
import { InjectionResolverFactory } from '../../../injection_resolver.js'
import { TypedKey, keyStr } from '../../../key.js'
import { Provider } from '../../../provider.js'
import { solutions } from '../../util/errutil/index.js'
import { excludeSelf, uniqueBindingOrThrow } from './_binding_util.js'
import { describeContext } from './_fmt.js'

export const providerFactory: InjectionResolverFactory = ctx => {
  if (ctx.descriptor.multiple) {
    return provideMultiple(ctx)
  }

  if (!ctx.descriptor.key) {
    throw new ErrMissingInjectionKey(
      `${describeContext(ctx)}: no injection key provided` +
        solutions(
          `- Use provide(key) to specify the dependency key`,
          `- For circular dependencies, use provide(defer(() => key)) to defer resolution`,
        ),
    )
  }

  const rawKey = ctx.descriptor.key

  if (rawKey instanceof DeferredCtor) {
    const p: Provider = { get: () => rawKey.createProxy(target => ctx.container.get(target as TypedKey<unknown>)) }
    return () => p
  }

  const key = rawKey as TypedKey<unknown>
  const binding = uniqueBindingOrThrow(ctx, key)
  if (!binding) {
    if (ctx.descriptor.optional) {
      const p: Provider = { get: () => undefined as any }
      return () => p
    }

    throw new ErrNoResolutionForKey(
      `${describeContext(ctx)}: no binding registered for key "${keyStr(key)}"` +
        solutions(
          `- Register a binding for key "${keyStr(key)}"`,
          `- If the dependency is optional, use optional(key)`,
        ),
    )
  }

  const p: Provider = { get: () => binding.factory(binding.ctx!) }

  return () => p
}

const provideMultiple: InjectionResolverFactory = ctx => {
  if (!ctx.descriptor.key) {
    throw new ErrMissingInjectionKey(
      `${describeContext(ctx)}: no injection key provided` +
        solutions(
          `- Use allOf(provide(key)) to specify the dependency key`,
          `- For circular dependencies, use provide(allOf(defer(() => key))) to defer resolution`,
        ),
    )
  }

  const rawKey = ctx.descriptor.key
  const key = (rawKey instanceof DeferredCtor ? rawKey.unwrap() : rawKey) as TypedKey<unknown>
  const bindings = excludeSelf(ctx.container.getBindings(key), ctx.key!, ctx.descriptor.key!, ctx.container)
  const p: Provider<unknown[]> = {
    get: () => {
      const results = new Array<unknown>(bindings.length)
      for (let i = 0; i < bindings.length; i++) {
        results[i] = bindings[i].factory(bindings[i].ctx!)
      }
      return results
    },
  }

  return () => p
}

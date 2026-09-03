import { DeferredCtor } from '../../../deferred_ctor.js'
import { InjectionResolverFactory } from '../../../injection_resolver.js'
import { TypedKey } from '../../../key.js'
import { assertInjectionKeyIsPresent } from './_assert.js'
import { excludeSelf, uniqueBindingOrThrow } from './_binding_util.js'

export const deferredFactory: InjectionResolverFactory = ctx => {
  assertInjectionKeyIsPresent(ctx, 'no injection key provided')

  const deferredKey = ctx.descriptor.key as DeferredCtor<unknown>

  if (ctx.descriptor.multiple) {
    return () => {
      const key = deferredKey.unwrap() as TypedKey<unknown>
      const bindings = excludeSelf(ctx.container.getBindings(key), ctx.key!, ctx.descriptor.key!, ctx.container)
      const results = new Array<unknown>(bindings.length)

      for (let i = 0; i < bindings.length; i++) {
        results[i] = bindings[i].factory(bindings[i].ctx!)
      }

      return results
    }
  }

  if (ctx.descriptor.optional) {
    const key = deferredKey.unwrap() as TypedKey<unknown>
    const binding = uniqueBindingOrThrow(ctx, key)
    if (!binding) {
      return () => undefined as unknown
    }

    return () => binding.factory(binding.ctx!)
  }

  return () => deferredKey.createProxy(target => ctx.container.get(target as TypedKey<unknown>))
}

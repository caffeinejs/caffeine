import { ErrNoResolutionForKey } from '../../../errors.js'
import { InjectionResolverFactory } from '../../../injection_resolver.js'
import { Identifier, keyStr, TypedKey } from '../../../key.js'
import { solutions } from '../../util/errutil/errutil.js'
import { assertInjectionKeyIsPresent, assertKeyIsPresent } from './_assert.js'
import { describeContext } from './_fmt.js'

export const mappedFactory: InjectionResolverFactory = ctx => {
  assertKeyIsPresent(ctx, 'no injection key provided')
  assertInjectionKeyIsPresent(ctx, 'no injection key provided')

  const key = ctx.descriptor.key as TypedKey<unknown>
  const bindings = ctx.container.getBindings(key)

  if (bindings.length === 0) {
    if (ctx.descriptor.optional) {
      return () => undefined as any
    }

    throw new ErrNoResolutionForKey(
      `${describeContext(ctx)}: no bindings registered for key "${keyStr(key)}"` +
        solutions(`- Register a binding for key "${keyStr(key)}"`),
    )
  }

  return () => {
    const result = new Map<Identifier, unknown>()

    for (const binding of bindings) {
      if (binding.names.length > 0) {
        result.set(binding.names[0], binding.factory(binding.ctx!))
      }
    }

    return result
  }
}

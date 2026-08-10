import type { Binding } from '../../../binding.js'
import { ErrNoValuesProvider } from '../../../errors.js'
import type { InjectionResolverFactory } from '../../../injection_resolver.js'
import { kValuesProvider } from '../../../values_provider.js'
import { describeContext } from './_fmt.js'

export const configFactory: InjectionResolverFactory = ctx => {
  const selector = ctx.descriptor.args as (provider: unknown) => unknown
  const optional = ctx.descriptor.optional ?? false

  const providerBinding = ctx.container.getBinding(kValuesProvider) as Binding<unknown> | undefined

  if (!providerBinding) {
    if (!optional) {
      throw new ErrNoValuesProvider(describeContext(ctx))
    }
    return () => undefined
  }

  return () => selector(providerBinding.factory(providerBinding.ctx!))
}

import type { Binding } from '../../../binding.js'
import { ErrNoValuesProvider } from '../../../errors.js'
import type { InjectionResolverFactory } from '../../../injection_resolver.js'
import { kValuesProvider } from '../../../values_provider.js'
import { describeContext } from './_fmt.js'

type ValueArgs = {
  access: ((provider: unknown) => unknown) | string
  defaultValue?: unknown
}

export const configFactory: InjectionResolverFactory = ctx => {
  const { access, defaultValue } = ctx.descriptor.args as ValueArgs
  const hasDefault = defaultValue !== undefined
  const optional = ctx.descriptor.optional ?? false

  const providerBinding = ctx.container.getBinding(kValuesProvider) as Binding<unknown> | undefined

  if (!providerBinding) {
    if (hasDefault) {
      return () => defaultValue
    }

    if (!optional) {
      throw new ErrNoValuesProvider(describeContext(ctx))
    }

    return () => undefined
  }

  const select: (provider: unknown) => unknown
    = typeof access === 'string'
      ? (() => {
          const keys = access.split('.')
          return (provider: unknown) =>
            keys.reduce(
              (acc: unknown, k) => (acc == null ? undefined : (acc as Record<string, unknown>)[k]),
              provider,
            )
        })()
      : (access as (provider: unknown) => unknown)

  return () => {
    const v = select(providerBinding.factory(providerBinding.ctx!))

    return v === undefined && hasDefault
      ? defaultValue!
      : v
  }
}

import { InjectionResolverFactory } from '../../../injection_resolver.js'

export const valueFactory: InjectionResolverFactory = ctx => {
  const v = ctx.descriptor.args
  return () => v
}

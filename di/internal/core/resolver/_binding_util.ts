import { Binding, getUniqueBinding } from '../../../binding.js'
import { ContainerOps } from '../../../container_interface.js'
import { ErrNoUniqueInjectionForKey } from '../../../errors.js'
import { InjectionResolverFactoryContext } from '../../../injection_resolver.js'
import { InjectionToken, keyStr, TypedKey } from '../../../key.js'
import { describeContext } from './_fmt.js'

export function excludeSelf<T>(
  bindings: Binding<T>[],
  consumerKey: InjectionToken,
  depKey: InjectionToken,
  container: ContainerOps,
): Binding<T>[] {
  if (consumerKey === depKey) {
    return bindings
  }

  const self = new Set(container.getBindings(consumerKey as TypedKey<T>))

  return self.size > 0 ? bindings.filter(b => !self.has(b)) : bindings
}

export function uniqueBindingOrThrow(
  ctx: InjectionResolverFactoryContext,
  key: InjectionToken,
): Binding<unknown> | undefined {
  return getUniqueBinding(ctx.container, key, undefined, () => {
    throw new ErrNoUniqueInjectionForKey(
      key,
      `${describeContext(ctx)}: Found more than one component bound to the key "${keyStr(key)}" when a single one was expected`,
    )
  })
}

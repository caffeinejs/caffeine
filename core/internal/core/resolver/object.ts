import { InjectionResolver, InjectionResolverFactory } from '../../../injection_resolver.js'
import { allOf, ObjectInjection, ObjectInjections, optional } from '../../../injection.js'
import { ContainerOps } from '../../../container_interface.js'
import { DeferredCtor } from '../../../deferred_ctor.js'
import { ErrNoResolutionForKey } from '../../../errors.js'
import { Key, TypedKey, keyStr } from '../../../key.js'
import { solutions } from '../../util/errutil/errutil.js'
import { excludeSelf } from './_binding_util.js'

export const objectFactory: InjectionResolverFactory = ctx =>
  compileObjectNode(ctx.container, ctx.key!, ctx.descriptor.args as ObjectInjections, '')

function compileObjectNode(
  container: ContainerOps,
  key: Key,
  node: ObjectInjection | ObjectInjections,
  fieldPath: string,
): InjectionResolver {
  if (!('children' in node)) {
    if (node.multiple) {
      if (node.key instanceof DeferredCtor) {
        const deferredKey = node.key
        return () => {
          const realKey = deferredKey.unwrap() as TypedKey<unknown>
          const bindings = excludeSelf(container.getBindings(realKey), key, deferredKey, container)
          const results = new Array<unknown>(bindings.length)
          for (let i = 0; i < bindings.length; i++) {
            results[i] = bindings[i].factory(bindings[i].ctx!)
          }
          return results
        }
      }
      const bindings = excludeSelf(
        container.getBindings(node.key! as TypedKey<unknown>),
        key,
        node.key!,
        container,
      )

      return () => {
        const results = new Array<unknown>(bindings.length)
        for (let i = 0; i < bindings.length; i++) {
          results[i] = bindings[i].factory(bindings[i].ctx!)
        }
        return results
      }
    }

    if (node.key instanceof DeferredCtor) {
      const deferredKey = node.key
      if (node.optional) {
        const realKey = deferredKey.unwrap() as TypedKey<unknown>
        const binding = container.getBinding(realKey)
        if (!binding) {
          return () => undefined as any
        }

        return () => binding.factory(binding.ctx!)
      }

      return () => deferredKey.createProxy(target => container.get(target as TypedKey<unknown>))
    }

    const binding = container.getBinding(node.key! as TypedKey<unknown>)

    if (!binding) {
      if (node.optional) {
        return () => undefined as any
      }

      throw new ErrNoResolutionForKey(
        `Cannot resolve "${keyStr(key)}" object field "${fieldPath}": no binding registered for key "${keyStr(node.key)}"`
        + solutions(
          `Register a binding for key "${keyStr(node.key)}"`,
          `For multiple injections, use ${allOf.name}(key)`,
          `If the dependency is optional, use ${optional.name}(key)`,
        ),
      )
    }

    return () => binding.factory(binding.ctx!)
  }

  const props: (string | symbol)[] = [...Object.keys(node.children), ...Object.getOwnPropertySymbols(node.children)]
  const entries: [string | symbol, InjectionResolver][] = props.map(prop => [
    prop,
    compileObjectNode(container, key, node.children[prop], fieldPath ? `${fieldPath}.${String(prop)}` : String(prop)),
  ])

  // Pre-compile the final object.
  // Each field is a getter that resolves the injection on-demand using the compiled resolver.

  const result: Record<string | symbol, unknown> = {}

  for (const [prop, resolver] of entries) {
    Object.defineProperty(result, prop, {
      get: () => resolver(),
      enumerable: true,
    })
  }

  return () => result
}

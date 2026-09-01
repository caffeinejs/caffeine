import { defaultResolverFor, resolverFor, type InjectionResolver, type InjectionResolverFactory } from '../../../injection_resolver.js'
import type { ObjectInjection, ObjectInjections } from '../../../injection.js'
import type { ContainerOps } from '../../../container_interface.js'
import type { InjectionToken } from '../../../key.js'

export const objectFactory: InjectionResolverFactory = ctx =>
  compileObjectNode(ctx.container, ctx.key!, ctx.descriptor.args as ObjectInjections, '')

function compileObjectNode(
  container: ContainerOps,
  key: InjectionToken,
  node: ObjectInjection | ObjectInjections,
  fieldPath: string,
): InjectionResolver {
  if (!('children' in node)) {
    return resolverFor(defaultResolverFor(node))({
      container,
      descriptor: node,
      key,
      kind: 'property',
      member: fieldPath,
      index: -1,
    })
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

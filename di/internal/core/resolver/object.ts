import { BuiltInResolvers, InjectionResolver, InjectionResolverFactory, resolverFor } from '../../../injection_resolver.js'
import { InjectionDescriptor, ObjectInjection, ObjectInjections } from '../../../injection.js'
import { ContainerOps } from '../../../container_interface.js'
import { DeferredCtor } from '../../../deferred_ctor.js'
import { InjectionToken } from '../../../key.js'

export const objectFactory: InjectionResolverFactory = ctx =>
  compileObjectNode(ctx.container, ctx.key!, ctx.descriptor.args as ObjectInjections, '')

function compileObjectNode(
  container: ContainerOps,
  key: InjectionToken,
  node: ObjectInjection | ObjectInjections,
  fieldPath: string,
): InjectionResolver {
  // A field is resolved by the same factory the injection would get anywhere else, so every helper works here
  // and a new one needs nothing added. The field path travels as the member, which is what names it in failures.
  if (!('children' in node)) {
    return resolverFor(resolverOf(node))({
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

/**
 * The resolver a field is compiled with.
 *
 * A helper names its own. A bare key names none, and a `DeferredCtor` written directly into a spec is a valid key,
 * so it has to be recognised here rather than left to the default.
 */
function resolverOf(node: InjectionDescriptor): symbol {
  if (node.resolver !== undefined) {
    return node.resolver
  }

  return node.key instanceof DeferredCtor ? BuiltInResolvers.DEFER : BuiltInResolvers.DEFAULT
}

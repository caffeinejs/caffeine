import type { ContainerOps } from '../../../container_interface.js'
import { DeferredCtor } from '../../../deferred_ctor.js'
import { ErrConflictingInjectionStages } from '../../../errors.js'
import type { InjectionStage, ObjectInjection, ObjectInjections } from '../../../injection.js'
import {
  type InjectionContext,
  type InjectionMiddleware,
  type InjectionResolver,
  type InjectionResolverFactoryContext,
  resolverFor,
  stageFor,
} from '../../../injection_resolver.js'
import type { InjectionToken, TypedKey } from '../../../key.js'
import { uniqueStage } from './stages.js'

const NO_BINDINGS = Object.freeze([])

// A terminal never calls `next`. Handing it one that throws turns a stage that forgets into a named failure at
// compile time rather than a resolver that silently returns undefined.
const noNext = (): never => {
  throw new Error('An injection stage marked terminal called next()')
}

/**
 * Folds a descriptor's stages into the single {@link InjectionResolver} the resolution path calls.
 *
 * The fold happens once, while the container compiles. Stages keep the order they were declared in, except that
 * the terminal always runs last — which is what makes `provide(ordered(key))` and `ordered(provide(key))` the
 * same chain, since one transforms bindings on the way down and the other wraps the resolver on the way back up.
 *
 * @throws {@link ErrConflictingInjectionStages} if two stages both decide what the injection resolves to.
 */
export function compileChain(base: InjectionResolverFactoryContext): InjectionResolver {
  const declared: readonly InjectionStage[] = base.descriptor.stages ?? []

  let terminal: InjectionMiddleware = uniqueStage
  let terminalArgs: unknown
  let terminalName: symbol | undefined

  const middlewares: InjectionMiddleware[] = []
  const middlewareArgs: unknown[] = []

  for (const stage of declared) {
    const registration = stageFor(stage.name)

    if (registration.terminal) {
      if (terminalName !== undefined) {
        throw new ErrConflictingInjectionStages(terminalName, stage.name)
      }

      terminalName = stage.name
      terminal = registration.middleware
      terminalArgs = stage.args
      continue
    }

    middlewares.push(registration.middleware)
    middlewareArgs.push(stage.args)
  }

  // A resolver registered through bindResolver is a terminal written the long way: it already takes the context
  // and returns the resolver, and it never had a `next` to call.
  const custom = base.descriptor.resolver

  if (custom !== undefined) {
    if (terminalName !== undefined) {
      throw new ErrConflictingInjectionStages(terminalName, custom)
    }

    const factory = resolverFor(custom)

    terminal = ctx => factory(ctx)
    terminalArgs = undefined
  }

  let next = (ctx: InjectionContext): InjectionResolver => terminal(ctx, noNext, terminalArgs)

  for (let i = middlewares.length - 1; i >= 0; i--) {
    const middleware = middlewares[i]
    const args = middlewareArgs[i]
    const downstream = next

    next = (ctx: InjectionContext): InjectionResolver => middleware(ctx, downstream, args)
  }

  return next(seed(base))
}

/**
 * The bindings a chain starts from.
 *
 * A deferred key is unwrapped here: the callback resolves by the time the container compiles, and `getBindings`
 * is a plain map lookup that would miss the {@link DeferredCtor} itself. Stages that need the original key, such
 * as the self-exclusion in the array terminal, read `descriptor.key`.
 */
function seed(base: InjectionResolverFactoryContext): InjectionContext {
  const rawKey = base.descriptor.key

  if (rawKey === undefined || rawKey === null) {
    return { ...base, bindings: NO_BINDINGS }
  }

  const key = (rawKey instanceof DeferredCtor ? rawKey.unwrap() : rawKey) as TypedKey<unknown>

  return { ...base, bindings: base.container.getBindings(key) }
}

/**
 * Resolves a bag whose properties are each their own chain.
 *
 * Properties are lazy getters, so one bag can hold dependencies of differing scopes: each resolves through its
 * own binding when it is read, not when the bag is built.
 */
export const objectStage: InjectionMiddleware = (ctx, _next, args) =>
  compileObjectNode(ctx.container, ctx.key!, args as ObjectInjections, '')

function compileObjectNode(
  container: ContainerOps,
  key: InjectionToken,
  node: ObjectInjection | ObjectInjections,
  fieldPath: string,
): InjectionResolver {
  if (!('children' in node)) {
    return compileChain({ container, descriptor: node, key, kind: 'property', member: fieldPath, index: -1 })
  }

  const props: (string | symbol)[] = [...Object.keys(node.children), ...Object.getOwnPropertySymbols(node.children)]
  const entries: [string | symbol, InjectionResolver][] = props.map(prop => [
    prop,
    compileObjectNode(container, key, node.children[prop], fieldPath ? `${fieldPath}.${String(prop)}` : String(prop)),
  ])

  const result: Record<string | symbol, unknown> = {}

  for (const [prop, resolver] of entries) {
    Object.defineProperty(result, prop, { get: () => resolver(), enumerable: true })
  }

  return () => result
}

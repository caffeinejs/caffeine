import { kAspectPointcuts, Pointcut } from './aop.js'
import { Binding } from './binding.js'
import { DeferredCtor } from './deferred_ctor.js'
import { ErrCircularDependency, ErrInvalidAspect, ErrUnresolvableDependencies } from './errors.js'
import { collectsMany, InjectionDescriptor, namesStage, ObjectInjections, stageArgs } from './injection.js'
import { BuiltInStages } from './injection_resolver.js'
import { keyStr, InjectionToken, Identifier, TypedKey } from './key.js'
import { Scopes } from './scope.js'

/**
 * Check if the container's dependency graph contains any wrongly
 * configured circular references.
 *
 * Constructor, property and method injections all count as edges: a scope caches an instance only after its
 * factory and the property/method injectors have run, so none of the three breaks a cycle. Only `$i.defer`
 * and `$i.provide` do, and an optional key nothing is bound to.
 */
export function checkCircularReferences(
  registry: Map<InjectionToken, Binding>,
  bindings: Map<InjectionToken | Identifier, Binding[]>,
): void {
  const bindingIDToKey = new Map<number, InjectionToken>()
  for (const [key, binding] of registry.entries()) {
    bindingIDToKey.set(binding.id, key)
  }

  const concreteKeys = (depKey: InjectionToken): InjectionToken[] => {
    if (registry.has(depKey)) {
      return [depKey]
    }

    const abstracts = bindings.get(depKey)
    if (abstracts === undefined) {
      return []
    }

    const keys: InjectionToken[] = []
    for (const b of abstracts) {
      const concreteKey = bindingIDToKey.get(b.id)
      if (concreteKey != null) {
        keys.push(concreteKey)
      }
    }

    return keys
  }

  const addEdges = (ownerKey: InjectionToken, desc: InjectionDescriptor, deps: InjectionToken[]): void => {
    // A provider re-resolves on every read, so it never re-enters its target while the consumer is being
    // constructed. Same carve-out the scope check makes.
    if (namesStage(desc, BuiltInStages.PROVIDER)) {
      return
    }

    if (desc.key instanceof DeferredCtor) {
      return
    }

    const depKey = desc.key as InjectionToken
    if (depKey == null) {
      return
    }

    // An optional dependency is only an edge when something is bound to it: an unbound key resolves to
    // undefined and closes nothing. That falls out of concreteKeys returning an empty list.
    const excludesSelf = collectsMany(desc) && ownerKey !== depKey

    for (const concrete of concreteKeys(depKey)) {
      // A collecting injection never receives the consumer's own bindings, so that edge is not real.
      if (excludesSelf && concrete === ownerKey) {
        continue
      }

      deps.push(concrete)
    }
  }

  const adj = new Map<InjectionToken, InjectionToken[]>()
  for (const [key, binding] of registry.entries()) {
    const deps: InjectionToken[] = []

    for (const desc of binding.injections) {
      addEdges(key, desc, deps)
    }

    for (const desc of binding.injectableProperties.values()) {
      addEdges(key, desc, deps)
    }

    for (const descs of binding.injectableMethods.values()) {
      for (const desc of descs) {
        addEdges(key, desc, deps)
      }
    }

    adj.set(key, deps)
  }

  const WHITE = 0
  const GRAY = 1
  const BLACK = 2

  const color = new Map<InjectionToken, 0 | 1 | 2>()
  for (const key of adj.keys()) {
    color.set(key, WHITE)
  }

  const dfs = (key: InjectionToken, path: InjectionToken[]): void => {
    color.set(key, GRAY)
    path.push(key)
    for (const dep of adj.get(key)!) {
      if (color.get(dep) === GRAY) {
        const cycleStart = path.indexOf(dep)
        const cycle = [...path.slice(cycleStart), dep]
        throw new ErrCircularDependency(cycle.map(k => `"${keyStr(k)}"`).join(' → '))
      }

      if (color.get(dep) === WHITE) {
        dfs(dep, path)
      }
    }

    path.pop()
    color.set(key, BLACK)
  }

  for (const key of adj.keys()) {
    if (color.get(key) === WHITE) {
      dfs(key, [])
    }
  }
}

/**
 * Check if the container's entire dependency graph is resolvable.
 */
export function checkIfContainerIsResolvable(
  registry: Map<InjectionToken, Binding>,
  getBindings: <T>(key: TypedKey<T>) => Binding<T>[],
): void {
  const issues: string[] = []

  for (const [key, binding] of registry.entries()) {
    const owner = keyStr(key)

    for (let i = 0; i < binding.injections.length; i++) {
      checkInjection(binding.injections[i], `"${owner}" constructor param[${i}]`, issues, getBindings)
    }

    for (const [propName, inj] of binding.injectableProperties) {
      checkInjection(inj, `"${owner}".${String(propName)}`, issues, getBindings)
    }

    for (const [methodName, injList] of binding.injectableMethods) {
      for (let i = 0; i < injList.length; i++) {
        checkInjection(injList[i], `"${owner}".${String(methodName)}[${i}]`, issues, getBindings)
      }
    }
  }

  if (issues.length > 0) {
    throw new ErrUnresolvableDependencies(issues)
  }
}

function checkInjection(
  inj: InjectionDescriptor,
  location: string,
  issues: string[],
  getBindings: <T>(key: TypedKey<T>) => Binding<T>[],
): void {
  if (namesStage(inj, BuiltInStages.OBJECT)) {
    checkObjectInjections(stageArgs(inj, BuiltInStages.OBJECT) as ObjectInjections, location, issues, getBindings)
    return
  }

  if (!inj.key) {
    return
  }

  const actualKey = inj.key instanceof DeferredCtor ? inj.key.unwrap() : inj.key
  const bindings = getBindings(actualKey as TypedKey<unknown>)

  if (bindings.length === 0) {
    if (!inj.optional) {
      issues.push(`Cannot resolve "${keyStr(actualKey)}" required by ${location}`)
    }
    return
  }

  if (!collectsMany(inj) && bindings.length > 1 && !bindings[0].primary) {
    issues.push(
      `Ambiguous resolution for "${keyStr(actualKey)}" required by ${location}: ${bindings.length} candidates found`,
    )
  }
}

function checkObjectInjections(
  obj: ObjectInjections,
  location: string,
  issues: string[],
  getBindings: <T>(key: TypedKey<T>) => Binding<T>[],
): void {
  const props: Array<string | symbol> = [...Object.keys(obj.children), ...Object.getOwnPropertySymbols(obj.children)]

  for (const prop of props) {
    const child = obj.children[prop]
    const childLocation = `${location}.${String(prop)}`

    if ('children' in child) {
      checkObjectInjections(child as ObjectInjections, childLocation, issues, getBindings)
    } else {
      checkInjection(child as InjectionDescriptor, childLocation, issues, getBindings)
    }
  }
}

// Takes the aspect bindings, not every binding: the container already indexes them by `kAspectLabel`, so
// re-deriving the same set by scanning the whole registry is a pass that buys nothing.
export function checkAspects(aspects: Iterable<[InjectionToken, Binding]>): void {
  for (const [key, binding] of aspects) {
    const pointcuts = binding.tags.get(kAspectPointcuts) as Pointcut[] | undefined
    if (!pointcuts || pointcuts.length === 0) {
      throw new ErrInvalidAspect(`Cannot compile aspect "${keyStr(key)}": at least one pointcut is required`)
    }
    const scope = binding.scopeID
    if (scope !== undefined && scope !== Scopes.SINGLETON) {
      throw new ErrInvalidAspect(`Cannot compile aspect "${keyStr(key)}": aspects must be singleton scoped`)
    }
  }
}

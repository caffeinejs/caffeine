import { Binding } from './binding.js'
import { DeferredCtor } from './deferred_ctor.js'
import { ErrCircularDependency, ErrUnresolvableDependencies } from './errors.js'
import { InjectionDescriptor, ObjectInjections } from './injection.js'
import { BuiltInResolvers } from './injection_resolver.js'
import { keyStr, Key, TypedKey } from './key.js'

/**
 * Check if the container's dependency graph contains any wrongly
 * configured circular references.
 */
export function checkCircularReferences(registry: Map<Key, Binding>, bindings: Map<Key, Binding[]>): void {
  const bindingIdToKey = new Map<number, Key>()
  for (const [key, binding] of registry.entries()) {
    bindingIdToKey.set(binding.id, key)
  }

  const adj = new Map<Key, Key[]>()
  for (const [key, binding] of registry.entries()) {
    const deps: Key[] = []
    for (const desc of binding.injections) {
      if (desc.optional || desc.multiple) {
        continue
      }

      if (desc.resolver === BuiltInResolvers.DEFER || desc.key instanceof DeferredCtor) {
        continue
      }

      const depKey = desc.key as Key
      if (depKey == null) {
        continue
      }

      if (registry.has(depKey)) {
        deps.push(depKey)
      } else {
        const abstracts = bindings.get(depKey)
        if (abstracts) {
          for (const b of abstracts) {
            const concreteKey = bindingIdToKey.get(b.id)
            if (concreteKey != null) {
              deps.push(concreteKey)
            }
          }
        }
      }
    }

    adj.set(key, deps)
  }

  const WHITE = 0
  const GRAY = 1
  const BLACK = 2

  const color = new Map<Key, 0 | 1 | 2>()
  for (const key of adj.keys()) {
    color.set(key, WHITE)
  }

  const dfs = (key: Key, path: Key[]): void => {
    color.set(key, GRAY)
    path.push(key)
    for (const dep of adj.get(key)!) {
      if (color.get(dep) === GRAY) {
        const cycleStart = path.indexOf(dep)
        const cycle = [...path.slice(cycleStart), dep]
        throw new ErrCircularDependency(cycle.map(k => `"${keyStr(k)}"`)
          .join(' → '))
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
  registry: Map<Key, Binding>,
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
  if (inj.resolver === BuiltInResolvers.OBJECT) {
    checkObjectInjections(inj.args as ObjectInjections, location, issues, getBindings)
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

  if (!inj.multiple && bindings.length > 1 && !bindings[0].primary) {
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

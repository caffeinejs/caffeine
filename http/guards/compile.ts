import { Scopes, type Binding, type Container, type InjectionToken, type Provider } from '@caffeinejs/di'

import { ErrConfiguration } from '../error/common.js'
import { solutions } from '../error/util.js'
import type { Guard } from './guard.js'

export type CompiledGuard =
  | { readonly kind: 'instance'; readonly instance: Guard }
  | { readonly kind: 'provider'; readonly provider: Provider<Guard> }

/**
 * Resolves `keys` to a dense chain. Empty input yields an empty array.
 *
 * Singleton guards whose graph does not reach request scope are instantiated once here.
 * Everything else is a {@link Provider} so `get()` runs inside the live request scope.
 *
 * `compiledByKey` is shared across globals and every route so an InjectionToken compiled twice (global +
 * `@UseGuards`, or the same guard on two methods) reuses the closed-over instance / provider.
 */
export function compileGuardKeys(
  container: Container,
  keys: readonly InjectionToken<Guard>[],
  owner: string,
  compiledByKey: Map<InjectionToken<Guard>, CompiledGuard>,
): CompiledGuard[] {
  const compiled = new Array<CompiledGuard>(keys.length)
  for (let i = 0; i < keys.length; i++) {
    compiled[i] = compileOne(container, keys[i], owner, compiledByKey)
  }
  return compiled
}

function compileOne(
  container: Container,
  key: InjectionToken<Guard>,
  owner: string,
  compiledByKey: Map<InjectionToken<Guard>, CompiledGuard>,
): CompiledGuard {
  const cached = compiledByKey.get(key)
  if (cached !== undefined) {
    return cached
  }

  const name = typeof key === 'function' ? key.name : String(key)
  const binding = container.getBinding(key) as Binding<Guard> | undefined
  if (binding === undefined) {
    throw new ErrConfiguration(
      `Cannot resolve guard "${name}" referenced by "${owner}": no binding registered` +
        solutions(
          `Decorate the guard with "@Injectable()" so it is registered in the container`,
          `Call "container.bind(${name}, t => t.toSelf())" if it is registered without decorators`,
        ),
    )
  }

  // Registration is by strong-typed key, so the key is trusted. What follows is a shape check, not a gate.
  const notAGuard = (): ErrConfiguration =>
    new ErrConfiguration(
      `Cannot use "${name}" as a guard in "${owner}": no "guard" method` +
        solutions(
          `A guard must expose a "guard(input)" method`,
          'List only guards in "@UseGuards" or "guards(g => g.global(...))"',
        ),
    )

  const requestScope = container.hasScopeInGraph(key, Scopes.REQUEST)
  const provider = container.wrapBinding<Guard>(binding)
  let compiled: CompiledGuard

  if (binding.scopeID === Scopes.SINGLETON && !requestScope) {
    // Built here anyway, so the instance itself is what gets checked.
    const instance = provider.get()
    if (typeof (instance as { guard?: unknown } | null)?.guard !== 'function') {
      throw notAGuard()
    }
    compiled = { kind: 'instance', instance }
  } else {
    // Nothing to instantiate outside a request: a class binding is checked by its prototype, a factory or
    // value binding is taken on trust.
    const proto = (typeof binding.type === 'function' ? binding.type.prototype : undefined) as
      | { guard?: unknown }
      | undefined
    if (proto !== undefined && typeof proto.guard !== 'function') {
      throw notAGuard()
    }
    compiled = { kind: 'provider', provider }
  }

  compiledByKey.set(key, compiled)
  return compiled
}

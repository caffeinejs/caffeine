import { Scopes, type Binding, type Container, type InjectionToken, type Provider } from '@caffeinejs/di'

import { ErrGuardConfiguration } from './errors.js'
import type { BaseGuard } from './guard.js'

export type CompiledGuard<G extends BaseGuard<never>> =
  | { readonly kind: 'instance'; readonly instance: G }
  | { readonly kind: 'provider'; readonly provider: Provider<G> }

/**
 * Resolves `keys` to a dense chain. Empty input yields an empty array.
 *
 * Singleton guards whose graph does not reach request scope are instantiated once here.
 * Everything else is a {@link Provider} so `get()` runs inside the live request scope.
 *
 * `compiledByKey` is shared across globals and every route so an InjectionToken compiled twice (a global and a
 * route's own, or the same guard on two routes) reuses the closed-over instance / provider.
 *
 * @param owner - What referenced the keys, named in failures, e.g. `PetController.list`
 * @throws ErrGuardConfiguration when a key has no binding, or its binding has no `guard` method.
 */
export function compileGuardKeys<G extends BaseGuard<never>>(
  container: Container,
  keys: readonly InjectionToken<G>[],
  owner: string,
  compiledByKey: Map<InjectionToken<G>, CompiledGuard<G>>,
): CompiledGuard<G>[] {
  const compiled = new Array<CompiledGuard<G>>(keys.length)
  for (let i = 0; i < keys.length; i++) {
    compiled[i] = compileOne(container, keys[i], owner, compiledByKey)
  }
  return compiled
}

function compileOne<G extends BaseGuard<never>>(
  container: Container,
  key: InjectionToken<G>,
  owner: string,
  compiledByKey: Map<InjectionToken<G>, CompiledGuard<G>>,
): CompiledGuard<G> {
  const cached = compiledByKey.get(key)
  if (cached !== undefined) {
    return cached
  }

  const name = typeof key === 'function' ? key.name : String(key)
  const binding = container.getBinding(key) as Binding<G> | undefined
  if (binding === undefined) {
    throw new ErrGuardConfiguration(
      `Cannot resolve guard "${name}" referenced by "${owner}": no binding registered`,
      `Decorate the guard with "@Injectable()" so it is registered in the container`,
      `Call "container.bind(${name}, t => t.toSelf())" if it is registered without decorators`,
    )
  }

  // Registration is by strong-typed key, so the key is trusted. What follows is a shape check, not a gate.
  const notAGuard = (): ErrGuardConfiguration =>
    new ErrGuardConfiguration(
      `Cannot use "${name}" as a guard in "${owner}": no "guard" method`,
      `A guard must expose a "guard(input)" method`,
      `Check that "${name}" names the guard and not another binding`,
    )

  const requestScope = container.hasScopeInGraph(key, Scopes.REQUEST)
  const provider = container.wrapBinding<G>(binding)
  let compiled: CompiledGuard<G>

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

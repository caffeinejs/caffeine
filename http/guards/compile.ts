import { Scopes, type Binding, type Container, type Key, type Provider } from '@caffeinejs/di'
import { ErrConfiguration } from '../error/common.js'
import { solutions } from '../error/util.js'
import { Guard } from './guard.js'
import type { GuardRef } from './keys.js'

export type CompiledGuard
  = | { readonly kind: 'instance', readonly instance: Guard }
    | { readonly kind: 'provider', readonly provider: Provider<Guard>, readonly requestScope: boolean }

/**
 * Resolves `keys` to a dense chain. Empty input yields an empty array.
 *
 * Singleton guards whose graph does not reach request scope are instantiated once here.
 * Everything else is a {@link Provider} so `get()` runs inside the live request scope.
 *
 * `compiledByKey` is shared across globals and every route so a Key compiled twice (global +
 * `@UseGuards`, or the same guard on two methods) reuses the closed-over instance / provider.
 */
export function compileGuardKeys(
  container: Container,
  keys: readonly GuardRef[],
  owner: string,
  compiledByKey: Map<GuardRef, CompiledGuard>,
): CompiledGuard[] {
  const compiled = new Array<CompiledGuard>(keys.length)
  for (let i = 0; i < keys.length; i++) {
    compiled[i] = compileOne(container, keys[i], owner, compiledByKey)
  }
  return compiled
}

function compileOne(
  container: Container,
  key: GuardRef,
  owner: string,
  compiledByKey: Map<GuardRef, CompiledGuard>,
): CompiledGuard {
  const cached = compiledByKey.get(key)
  if (cached !== undefined) {
    return cached
  }

  const name = typeof key === 'function' ? key.name : String(key)
  const bindings = container.getBindings(key)
  if (bindings.length === 0) {
    throw new ErrConfiguration(
      `Cannot resolve guard "${name}" referenced by "${owner}": no binding registered`
      + solutions(
        `Decorate the guard with "@Injectable()" so it is registered in the container`,
        `Call "bind(${name}).toSelf()" if it is registered without decorators`,
      ),
    )
  }

  const binding = container.getBinding(key) as Binding<Guard>
  if (!isGuardBinding(binding, key)) {
    throw new ErrConfiguration(
      `Cannot use "${name}" as a guard in "${owner}": it is not a container-managed Guard`
      + solutions(
        `"${name}" must extend Guard`,
        'List only Guard subclasses in "@UseGuards" or "guards(g => g.use(...))"',
      ),
    )
  }

  const requestScope = container.hasScopeInGraph(key, Scopes.REQUEST)
  const provider = container.wrapBinding<Guard>(binding)
  const compiled: CompiledGuard
    = binding.scopeID === Scopes.SINGLETON && !requestScope
      ? { kind: 'instance', instance: provider.get() }
      : { kind: 'provider', provider, requestScope }

  compiledByKey.set(key, compiled)
  return compiled
}

function isGuardBinding(binding: Binding, key: Key<Guard>): boolean {
  if (typeof key === 'function' && key.prototype instanceof Guard) {
    return true
  }

  const type = binding.type
  return typeof type === 'function' && type.prototype instanceof Guard
}

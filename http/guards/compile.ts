import { Scopes, type Binding, type Container, type Provider } from '@caffeinejs/di'

import { ErrConfiguration } from '../error/common.js'
import { solutions } from '../error/util.js'
import type { Guard } from './guard.js'
import type { GuardRef } from './keys.js'

export type CompiledGuard =
  | { readonly kind: 'instance'; readonly instance: Guard }
  | { readonly kind: 'provider'; readonly provider: Provider<Guard>; readonly requestScope: boolean }

/**
 * Resolves `keys` to a dense chain. Empty input yields an empty array.
 *
 * Singleton guards whose graph does not reach request scope are instantiated once here.
 * Everything else is a {@link Provider} so `get()` runs inside the live request scope.
 *
 * `compiledByKey` is shared across globals and every route so a InjectionToken compiled twice (global +
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
  const binding = container.getBinding(key) as Binding<Guard> | undefined
  if (binding === undefined) {
    throw new ErrConfiguration(
      `Cannot resolve guard "${name}" referenced by "${owner}": no binding registered` +
        solutions(
          `Decorate the guard with "@Injectable()" so it is registered in the container`,
          `Call "bind(${name}).toSelf()" if it is registered without decorators`,
        ),
    )
  }

  // Registration is by strong-typed key, so the key is trusted. This is a shape check, not a gate:
  // when a class prototype is reachable it must carry the `guard()` method; a factory or value
  // binding has no prototype to inspect and is taken on trust.
  const proto = (typeof binding.type === 'function' ? binding.type : typeof key === 'function' ? key : undefined)
    ?.prototype as { guard?: unknown } | undefined
  if (proto !== undefined && typeof proto.guard !== 'function') {
    throw new ErrConfiguration(
      `Cannot use "${name}" as a guard in "${owner}": no "guard" method` +
        solutions(
          `A guard must expose a "guard(input)" method`,
          'List only guards in "@UseGuards" or "guards(g => g.global(...))"',
        ),
    )
  }

  const requestScope = container.hasScopeInGraph(key, Scopes.REQUEST)
  const provider = container.wrapBinding<Guard>(binding)
  const compiled: CompiledGuard =
    binding.scopeID === Scopes.SINGLETON && !requestScope
      ? { kind: 'instance', instance: provider.get() }
      : { kind: 'provider', provider, requestScope }

  compiledByKey.set(key, compiled)
  return compiled
}

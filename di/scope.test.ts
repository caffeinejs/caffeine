import { describe, expect, it } from 'vitest'

import { ErrIllegalScopeState } from './errors.js'
import { bindScope, hasScope, scopeLabel, Scopes, unbindScope } from './scope.js'

describe('Scopes.REQUEST', () => {
  // Each container builds its own request scope on its context storage: a factory bound under its token would be
  // replaced by it, or stand in for it where the container has no storage.
  it('refuses a factory bound under the request scope token, and is not in the registry', () => {
    expect(() => bindScope(Scopes.REQUEST, () => ({}) as never)).toThrow(ErrIllegalScopeState)
    expect(() => bindScope(Scopes.REQUEST, () => ({}) as never)).toThrow(
      'Cannot bind scope "Request": each container builds it on its context storage',
    )
    expect(hasScope(Scopes.REQUEST)).toBe(false)
  })

  // A scope mismatch names the scopes it found: the request scope reads as such, though no factory is registered for it.
  it('is labelled Request', () => {
    expect(scopeLabel(Scopes.REQUEST)).toBe('Request')
  })
})

describe('unbindScope', () => {
  // Every container relies on its built-in scopes: without the singleton scope no default binding resolves.
  it.each([
    ['singleton', Scopes.SINGLETON],
    ['refresh', Scopes.REFRESH],
  ])('refuses to unbind the built-in %s scope', (_name, scopeID) => {
    expect(() => unbindScope(scopeID)).toThrow(ErrIllegalScopeState)
    expect(hasScope(scopeID)).toBe(true)
  })
})

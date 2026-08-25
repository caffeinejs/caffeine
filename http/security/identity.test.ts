import { describe, expect, it } from 'vitest'
import { Claim, Identity, Principal, newAnonymousUser } from './identity.js'

/**
 * The principal model. It had no test file at all — every behaviour below was exercised only incidentally
 * through handlers that happened to call it.
 */

const claim = (type: string, value: unknown) => new Claim(type, value, 'test')

describe('Identity', () => {
  it('defaults to no claims and a `roles` role claim type', () => {
    const identity = new Identity('test', true)

    expect(identity.claims).toEqual([])
    expect(identity.roleClaimType).toBe('roles')
  })

  it('appends a claim', () => {
    const identity = new Identity('test', true, [claim('sub', 'u1')])
    identity.addClaim(claim('email', 'a@b.c'))

    expect(identity.claims.map(c => c.type)).toEqual(['sub', 'email'])
  })

  // Both halves matter: an implementation of `filter(predicate)` rather than `filter(c => !predicate(c))`
  // passes an "is it gone?" assertion vacuously when only one claim exists, so the survivor is asserted too.
  it('removes the claims its predicate matches and keeps the rest', () => {
    const identity = new Identity('test', true, [claim('sub', 'u1'), claim('email', 'a@b.c')])

    identity.removeClaimBy(c => c.type === 'sub')

    expect(identity.claims.map(c => c.type)).toEqual(['email'])
  })

  it('removes every match, not only the first', () => {
    const identity = new Identity('test', true, [claim('scope', 'a'), claim('sub', 'u1'), claim('scope', 'b')])

    identity.removeClaimBy(c => c.type === 'scope')

    expect(identity.claims.map(c => c.type)).toEqual(['sub'])
  })

  it('leaves the claims untouched when nothing matches', () => {
    const identity = new Identity('test', true, [claim('sub', 'u1')])

    identity.removeClaimBy(() => false)

    expect(identity.claims.map(c => c.type)).toEqual(['sub'])
  })
})

describe('Principal', () => {
  const principal = () => new Principal(true, [
    new Identity('a', true, [claim('sub', 'u1'), claim('scope', 'read')]),
    new Identity('b', true, [claim('scope', 'write'), claim('roles', ['admin'])]),
  ])

  it('accepts a single identity as well as an array', () => {
    const one = new Principal(true, new Identity('a', true, [claim('sub', 'u1')]))

    expect(one.identities).toHaveLength(1)
    expect(one.findFirst('sub')?.value).toBe('u1')
  })

  it('findFirst returns the first matching claim across identities', () => {
    expect(principal().findFirst('scope')?.value).toBe('read')
  })

  it('findFirst returns undefined for an absent type', () => {
    expect(principal().findFirst('nope')).toBeUndefined()
  })

  it('findAll collects the claim from every identity', () => {
    expect(principal().findAll('scope').map(c => c.value)).toEqual(['read', 'write'])
  })

  it('claims() returns everything, and claims(type) only that type', () => {
    expect(principal().claims()).toHaveLength(4)
    expect(principal().claims('scope').map(c => c.value)).toEqual(['read', 'write'])
  })

  it('hasClaim checks presence, and presence with a value', () => {
    expect(principal().hasClaim('sub')).toBe(true)
    expect(principal().hasClaim('sub', 'u1')).toBe(true)
    expect(principal().hasClaim('sub', 'other')).toBe(false)
    expect(principal().hasClaim('nope')).toBe(false)
  })

  it('isInRole reads a scalar and an array role claim', () => {
    const scalar = new Principal(true, [new Identity('a', true, [claim('roles', 'admin')])])

    expect(scalar.isInRole('admin')).toBe(true)
    expect(principal().isInRole('admin')).toBe(true)
    expect(principal().isInRole('nope')).toBe(false)
  })

  it('resolves roles per identity, honouring each identity\'s own roleClaimType', () => {
    const mixed = new Principal(true, [
      new Identity('a', true, [claim('roles', 'reader')]),
      new Identity('b', true, [claim('scope', 'writer')], 'scope'),
    ])

    expect(mixed.isInRole('reader')).toBe(true)
    expect(mixed.isInRole('writer')).toBe(true)
  })

  it('addIdentity appends', () => {
    const p = principal()
    p.addIdentity(new Identity('c', true, [claim('extra', 1)]))

    expect(p.identities).toHaveLength(3)
    expect(p.hasClaim('extra', 1)).toBe(true)
  })
})

describe('the anonymous user', () => {
  it('is unauthenticated and carries no claims', () => {
    const anon = newAnonymousUser()

    expect(anon.authenticated).toBe(false)
    expect(anon.claims()).toEqual([])
    expect(anon.isInRole('anything')).toBe(false)
  })

  // `newAnonymousUser()` hands out one shared instance to every anonymous request. That is safe only while
  // it stays immutable, and `addIdentity` throwing is the entire guard — so both facts are pinned here. If
  // the throw were ever relaxed, one request could add an identity that every other anonymous request sees.
  it('is a single shared instance', () => {
    expect(newAnonymousUser()).toBe(newAnonymousUser())
  })

  it('refuses to accept an identity, which is what keeps sharing it safe', () => {
    expect(() => newAnonymousUser().addIdentity(new Identity('x', true, [])))
      .toThrow('Anonymous user cannot add identities')
  })
})

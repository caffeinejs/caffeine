import { describe, expect, it } from 'vitest'

import { Claim, Identity, Principal, anonymousUser } from './identity.js'

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

  // A store may hand one identity to every request that presents the same credential, so nothing changes it:
  // what would be a change answers with another identity.
  it('answers with another identity that also holds the added claims, and keeps its own', () => {
    const identity = new Identity('test', true, [claim('sub', 'u1')], 'scope')

    const wider = identity.withClaims(claim('email', 'a@b.c'), claim('scope', 'read'))

    expect(wider.claims.map(c => c.type)).toEqual(['sub', 'email', 'scope'])
    expect(identity.claims.map(c => c.type)).toEqual(['sub'])
    expect(wider).toMatchObject({ authenticationType: 'test', authenticated: true, roleClaimType: 'scope' })
  })

  // Both halves matter: an implementation of `filter(predicate)` rather than `filter(c => !predicate(c))`
  // passes an "is it gone?" assertion vacuously when only one claim exists, so the survivor is asserted too.
  it('answers with another identity without the claims its predicate matches, every one of them', () => {
    const identity = new Identity('test', true, [claim('scope', 'a'), claim('sub', 'u1'), claim('scope', 'b')])

    expect(identity.withoutClaims(c => c.type === 'scope').claims.map(c => c.type)).toEqual(['sub'])
    expect(identity.withoutClaims(() => false).claims.map(c => c.type)).toEqual(['scope', 'sub', 'scope'])
    expect(identity.claims).toHaveLength(3)
  })

  it('cannot be changed through the claims it hands out, nor through the array it was given', () => {
    const given = [claim('sub', 'u1')]
    const identity = new Identity('test', true, given)

    given.push(claim('roles', 'admin'))

    expect(identity.claims.map(c => c.type)).toEqual(['sub'])
    expect(() => (identity.claims as Claim[]).push(claim('roles', 'admin'))).toThrow(TypeError)
  })
})

// `isInRole` and `hasClaim` read a list-valued claim member by member, and one identity may serve every request
// that presents the same credential. A list that could still be written to would let one request grant a role to
// all the others.
describe('Claim', () => {
  it('holds a list no one can add a role to, neither through the claim nor through the array it was given', () => {
    const given = ['user']
    const roles = claim('roles', given)
    const principal = new Principal(true, new Identity('test', true, [roles]))

    expect(() => (roles.value as string[]).push('admin')).toThrow(TypeError)
    given.push('admin')

    expect(roles.value).toEqual(['user'])
    expect(principal.isInRole('admin')).toBe(false)
    expect(principal.hasClaim('roles', 'admin')).toBe(false)
  })

  // Freezing happens to a copy: the array belongs to whoever passed it, and they may go on using it.
  it('leaves the array it was given writable', () => {
    const given = ['user']
    claim('roles', given)

    expect(Object.isFrozen(given)).toBe(false)
  })

  it('takes any other value as it is', () => {
    const profile = { plan: 'pro' }

    expect(claim('sub', 'u1').value).toBe('u1')
    expect(claim('age', 42).value).toBe(42)
    expect(claim('profile', profile).value).toBe(profile)
  })
})

describe('Principal', () => {
  const principal = () =>
    new Principal(true, [
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
    expect(
      principal()
        .findAll('scope')
        .map(c => c.value),
    ).toEqual(['read', 'write'])
  })

  it('claims() returns everything, and claims(type) only that type', () => {
    expect(principal().claims()).toHaveLength(4)
    expect(
      principal()
        .claims('scope')
        .map(c => c.value),
    ).toEqual(['read', 'write'])
  })

  it('hasClaim checks presence, and presence with a value', () => {
    expect(principal().hasClaim('sub')).toBe(true)
    expect(principal().hasClaim('sub', 'u1')).toBe(true)
    expect(principal().hasClaim('sub', 'other')).toBe(false)
    expect(principal().hasClaim('nope')).toBe(false)
  })

  // A token carries `groups` as one claim holding a list, which is how identity providers send it. A policy that
  // asks for a member could never be satisfied while only `isInRole` looked inside one.
  it('hasClaim finds a member of a claim that holds a list', () => {
    const p = new Principal(true, [
      new Identity('a', true, [claim('groups', ['eng', 'on-call']), claim('dept', 'eng')]),
    ])

    expect(p.hasClaim('groups', 'on-call')).toBe(true)
    expect(p.hasClaim('groups', 'sales')).toBe(false)
    expect(p.hasClaim('groups')).toBe(true)
    // Membership, not containment: a list is not a member of itself, and a scalar still compares as one.
    expect(p.hasClaim('groups', ['eng', 'on-call'])).toBe(false)
    expect(p.hasClaim('dept', 'eng')).toBe(true)
    expect(p.hasClaim('dept', 'e')).toBe(false)
  })

  it('isInRole reads a scalar and an array role claim', () => {
    const scalar = new Principal(true, [new Identity('a', true, [claim('roles', 'admin')])])

    expect(scalar.isInRole('admin')).toBe(true)
    expect(principal().isInRole('admin')).toBe(true)
    expect(principal().isInRole('nope')).toBe(false)
  })

  it("resolves roles per identity, honouring each identity's own roleClaimType", () => {
    const mixed = new Principal(true, [
      new Identity('a', true, [claim('roles', 'reader')]),
      new Identity('b', true, [claim('scope', 'writer')], 'scope'),
    ])

    expect(mixed.isInRole('reader')).toBe(true)
    expect(mixed.isInRole('writer')).toBe(true)
  })

  it('answers with another principal that also holds the added identity, and keeps its own', () => {
    const p = principal()
    const wider = p.withIdentity(new Identity('c', true, [claim('extra', 1)]))

    expect(wider.identities).toHaveLength(3)
    expect(wider.hasClaim('extra', 1)).toBe(true)
    expect(wider.authenticated).toBe(true)
    expect(p.identities).toHaveLength(2)
    expect(p.hasClaim('extra')).toBe(false)
  })

  it('cannot be changed through the identities it hands out, nor through the array it was given', () => {
    const given = [new Identity('a', true, [claim('sub', 'u1')])]
    const p = new Principal(true, given)

    given.push(new Identity('b', true, [claim('roles', 'admin')]))

    expect(p.identities).toHaveLength(1)
    expect(() => (p.identities as Identity[]).push(given[1])).toThrow(TypeError)
  })
})

describe('the anonymous user', () => {
  it('is unauthenticated and carries no claims', () => {
    const anon = anonymousUser()

    expect(anon.authenticated).toBe(false)
    expect(anon.claims()).toEqual([])
    expect(anon.isInRole('anything')).toBe(false)
  })

  // One instance for every unauthenticated request in the process, which is only sound because nothing can be
  // added to it: what one request did to it, every other would see.
  it('is one instance that nothing can add to', () => {
    const anon = anonymousUser()

    expect(anonymousUser()).toBe(anon)
    expect(() => (anon.identities as Identity[]).push(new Identity('x', true, []))).toThrow(TypeError)

    const other = anon.withIdentity(new Identity('x', true, [claim('sub', 'u1')]))
    expect(other).not.toBe(anon)
    expect(anonymousUser().identities).toEqual([])
  })
})

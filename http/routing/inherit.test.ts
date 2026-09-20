import { describe, expect, it } from 'vitest'

import { foldAuthz, mergeAuthz } from './inherit.js'
import type { RouteAuthz, RouteAuthzOptions } from './spec.js'

function declared(...options: RouteAuthzOptions[]): RouteAuthz | undefined {
  return options.reduce<RouteAuthz | undefined>(foldAuthz, undefined)
}

describe('foldAuthz — declarations on one level', () => {
  it('keeps each roles declaration as a requirement of its own', () => {
    expect(declared({ roles: ['admin', 'manager'] }, { roles: ['auditor'] })?.roleGroups).toEqual([
      ['admin', 'manager'],
      ['auditor'],
    ])
  })

  it('accumulates policies, once each, whether named alone or in a list', () => {
    expect(declared({ policy: 'a' }, { policy: ['b', 'a'] })?.policies).toEqual(['a', 'b'])
  })

  it('accumulates the schemes of every declaration that names some', () => {
    expect(declared({ schemes: ['Basic'] }, { roles: ['admin'] }, { schemes: ['Bearer', 'Basic'] })?.schemes).toEqual([
      'Basic',
      'Bearer',
    ])
    expect(declared({ roles: ['admin'] })?.schemes).toBeUndefined()
  })

  it('asks for the default policy when a declaration names no requirement of its own', () => {
    expect(declared({})?.defaultPolicy).toBe(true)
    expect(declared({ schemes: ['Basic'] })?.defaultPolicy).toBe(true)
    expect(declared({ roles: [] })?.defaultPolicy).toBe(true)
    expect(declared({ allowAnonymous: false })?.defaultPolicy).toBe(true)

    expect(declared({ roles: ['admin'] })?.defaultPolicy).toBe(false)
    expect(declared({ policy: 'a' })?.defaultPolicy).toBe(false)
    expect(declared({ allowAnonymous: true })?.defaultPolicy).toBe(false)
  })

  it('keeps the request for the default policy when a later declaration names a requirement', () => {
    expect(declared({}, { policy: 'a' })?.defaultPolicy).toBe(true)
    expect(declared({ policy: 'a' }, {})?.defaultPolicy).toBe(true)
  })

  it('stays public once declared public, in whichever order', () => {
    expect(declared({ allowAnonymous: true }, { roles: ['admin'] })?.allowAnonymous).toBe(true)
    expect(declared({ roles: ['admin'] }, { allowAnonymous: true })?.allowAnonymous).toBe(true)
  })

  it('does not share the caller’s arrays', () => {
    const roles = ['admin']
    const folded = declared({ roles })

    roles.push('manager')

    expect(folded?.roleGroups).toEqual([['admin']])
  })
})

describe('mergeAuthz — an outer level and an inner one', () => {
  it('hands back the only level that declared anything', () => {
    const level = declared({ roles: ['admin'] })

    expect(mergeAuthz(level, undefined)).toBe(level)
    expect(mergeAuthz(undefined, level)).toBe(level)
    expect(mergeAuthz(undefined, undefined)).toBeUndefined()
  })

  // The inner level's roles used to be merged into the outer level's list, which made either set enough.
  it('adds the inner role groups to the outer ones instead of merging them into one', () => {
    const merged = mergeAuthz(declared({ roles: ['admin'] }), declared({ roles: ['auditor'] }))

    expect(merged?.roleGroups).toEqual([['admin'], ['auditor']])
  })

  it('unions policies and lets the inner level choose the schemes', () => {
    const outer = declared({ policy: 'a', schemes: ['Bearer'] })

    expect(mergeAuthz(outer, declared({ policy: ['a', 'b'] }))).toMatchObject({
      policies: ['a', 'b'],
      schemes: ['Bearer'],
    })
    expect(mergeAuthz(outer, declared({ schemes: ['Basic'] }))?.schemes).toEqual(['Basic'])
  })

  it('lets the inner level decide whether the result is public', () => {
    const open = declared({ allowAnonymous: true })
    const closed = declared({ roles: ['admin'] })

    expect(mergeAuthz(closed, open)?.allowAnonymous).toBe(true)
    expect(mergeAuthz(open, closed)?.allowAnonymous).toBe(false)
  })

  it('carries the outer requirements through a public level, for whatever protects itself again below it', () => {
    const merged = mergeAuthz(
      mergeAuthz(declared({ roles: ['admin'] }), declared({ allowAnonymous: true })),
      declared({}),
    )

    expect(merged).toMatchObject({ allowAnonymous: false, defaultPolicy: true, roleGroups: [['admin']] })
  })
})

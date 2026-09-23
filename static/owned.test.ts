import type { Route, RouteGroup } from '@caffeinejs/http'
import { describe, expect, it } from 'vitest'

import { deriveServerOwnedPaths, isServerOwned } from './_owned.js'

describe('deriveServerOwnedPaths', () => {
  const route = (path: string): Route<any> => ({ path }) as Route<any>
  const router = (path: string, routes: string[], prefix?: string): RouteGroup<any> =>
    ({ path, prefix, routes: routes.map(route) }) as RouteGroup<any>

  it('takes the controller base, so a sibling miss stays owned', () => {
    // `@Controller('/api')` with only `@Get('/')` still owns all of /api — otherwise /api/typo escapes.
    expect(deriveServerOwnedPaths([router('/api', ['/'])])).toEqual(['/api'])
  })

  it('includes the @Prefix', () => {
    expect(deriveServerOwnedPaths([router('/users', ['/list'], '/v1')])).toEqual(['/v1/users'])
  })

  it('truncates at the first dynamic segment', () => {
    expect(deriveServerOwnedPaths([router('/users/:id/photos', ['/'])])).toEqual(['/users'])
  })

  it('falls back to route paths for a controller mounted at the root', () => {
    expect(deriveServerOwnedPaths([router('/', ['/health', '/metrics'])])).toEqual(['/health', '/metrics'])
  })

  // The shell's own group: a wildcard at the root owns nothing, or it would own the whole origin.
  it('takes nothing from a root wildcard route', () => {
    expect(deriveServerOwnedPaths([router('', ['/*'])])).toEqual([])
  })
})

describe('isServerOwned', () => {
  it('matches by whole segments', () => {
    const owned = ['/api']
    expect(isServerOwned(owned, '/api')).toBe(true)
    expect(isServerOwned(owned, '/api/pets')).toBe(true)
    expect(isServerOwned(owned, '/apifoo')).toBe(false)
    expect(isServerOwned(owned, '/apifoo/bar')).toBe(false)
  })
})

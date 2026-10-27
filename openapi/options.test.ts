import { describe, expect, it } from 'vitest'

import { toRouteAuthz } from './options.js'

describe('toRouteAuthz', () => {
  // Any defined authz, even `{}`, is protection to the routing layer, so public must stay `undefined`.
  it('compiles no protection to undefined', () => {
    expect(toRouteAuthz(undefined)).toBe(undefined)
  })

  it('carries schemes, roles and policy over', () => {
    expect(toRouteAuthz({ schemes: ['Basic'], roles: ['docs:read'], policy: 'internal' })).toEqual({
      schemes: ['Basic'],
      roles: ['docs:read'],
      policy: 'internal',
    })
  })
})

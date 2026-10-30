import { describe, expect, it } from 'vitest'

import { OpenAPISecurityBuilder } from './security_builder.js'

describe('OpenAPISecurityBuilder', () => {
  it('collects schemes, roles and policies across calls', () => {
    const options = new OpenAPISecurityBuilder()
      .schemes('Basic')
      .schemes('Bearer')
      .roles('docs:read')
      .policy('internal', 'staff')
      .build()

    expect(options).toEqual({ schemes: ['Basic', 'Bearer'], roles: ['docs:read'], policy: ['internal', 'staff'] })
  })

  // An empty object is what the routing layer reads as "require an authenticated user".
  it('builds an empty requirement when nothing was named', () => {
    expect(new OpenAPISecurityBuilder().build()).toEqual({})
  })
})

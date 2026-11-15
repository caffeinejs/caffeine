import { describe, expect, it } from 'vitest'

import { ACCESS_CONTROL_EXEMPT, isAccessControlExempt, kAccessControlExempt } from './exempt.js'

// Only the framework's own value marks a route: a config an application writes in code cannot drop its access control.
describe('isAccessControlExempt', () => {
  it('is true for the framework mark', () => {
    expect(isAccessControlExempt(new Map([[kAccessControlExempt, ACCESS_CONTROL_EXEMPT]]))).toBe(true)
  })

  it('is false for a value an application could write under the same key', () => {
    expect(isAccessControlExempt(new Map([[kAccessControlExempt, true]]))).toBe(false)
  })

  it('is false for a route that carries no mark', () => {
    expect(isAccessControlExempt(new Map())).toBe(false)
  })
})

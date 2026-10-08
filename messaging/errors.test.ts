import { describe, expect, it } from 'vitest'

import { ErrUnknownBinder } from './errors.js'

describe('ErrUnknownBinder', () => {
  it('offers the registered binders to point the binding at', () => {
    const err = new ErrUnknownBinder('orders', 'ghost', ['primary', 'audit'])

    expect(err.message).toContain('.use("ghost", ...)')
    expect(err.message).toContain('at a registered binder: "primary", "audit"')
  })

  it('offers no other binder when none is registered', () => {
    // Pointing the binding elsewhere is no fix when there is nowhere to point it.
    const err = new ErrUnknownBinder('orders', 'ghost', [])

    expect(err.message).toContain('.use("ghost", ...)')
    expect(err.message).not.toContain('registered binder')
  })
})

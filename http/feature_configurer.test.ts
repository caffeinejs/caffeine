import { describe, it, expect } from 'vitest'
import { FeatureConfigurer, orderConfigurers } from './feature_configurer.js'

// orderConfigurers only reads name/before/after — a lightweight literal is enough.
function fc(name: string, deps: { before?: string[], after?: string[] } = {}): FeatureConfigurer {
  return { name, before: deps.before, after: deps.after } as FeatureConfigurer
}

const names = (cs: FeatureConfigurer[]) => cs.map(c => c.name)

describe('orderConfigurers', () => {
  it('keeps input order when there are no dependencies (stable)', () => {
    const list = [fc('a'), fc('b'), fc('c')]
    expect(names(orderConfigurers(list))).toEqual(['a', 'b', 'c'])
  })

  it('orders by `after`: a dependent runs after its dependency', () => {
    const list = [fc('authorization', { after: ['authentication'] }), fc('authentication')]
    expect(names(orderConfigurers(list))).toEqual(['authentication', 'authorization'])
  })

  it('orders by `before`', () => {
    const list = [fc('b'), fc('a', { before: ['b'] })]
    expect(names(orderConfigurers(list))).toEqual(['a', 'b'])
  })

  it('slots a configurer between two others via after + before', () => {
    const list = [fc('a'), fc('b'), fc('mid', { after: ['a'], before: ['b'] })]
    expect(names(orderConfigurers(list))).toEqual(['a', 'mid', 'b'])
  })

  it('ignores unknown dependency names (optional dependency absent)', () => {
    const list = [fc('a', { after: ['ghost'] }), fc('b', { before: ['phantom'] })]
    expect(names(orderConfigurers(list))).toEqual(['a', 'b'])
  })

  it('throws on a dependency cycle', () => {
    const list = [fc('a', { after: ['b'] }), fc('b', { after: ['a'] })]
    expect(() => orderConfigurers(list)).toThrow('dependency cycle')
  })

  it('returns an empty array for no configurers', () => {
    expect(orderConfigurers([])).toEqual([])
  })
})

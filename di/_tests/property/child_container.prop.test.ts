import { describe, expect } from 'vitest'
import { it, fc } from '@fast-check/vitest'
import { token } from '../../key.js'
import { buildChildScenario } from './helpers/child_di_builder.js'

describe('child container hierarchy (property)', function () {
  it.prop([fc.uniqueArray(fc.string({ minLength: 1, maxLength: 8 }), { minLength: 0, maxLength: 12 })], {
    numRuns: 100,
  })('child-only keys resolve in child but not parent', async keys => {
    const parentOnly = keys.filter((_, i) => i % 3 === 0)
    const childOnly = keys.filter((_, i) => i % 3 === 1)
    const sharedKeys = keys.filter((_, i) => i % 3 === 2)
    const shared = sharedKeys.map(key => ({
      key,
      parentValue: `p-${key}`,
      childValue: `c-${key}`,
    }))

    const { parent, child } = buildChildScenario({ parentOnly, childOnly, shared })
    await parent.init()
    await child.init()

    for (const key of childOnly) {
      expect(child.get(token<string>(key)))
        .toBe(`child-${key}`)
      expect(() => parent.get(token<string>(key)))
        .toThrow()
    }
  })

  it.prop([fc.uniqueArray(fc.string({ minLength: 1, maxLength: 8 }), { minLength: 1, maxLength: 12 })], {
    numRuns: 100,
  })('parent-only keys fall through to child', async keys => {
    const parentOnly = keys.filter((_, i) => i % 2 === 0)
    const childOnly = keys.filter((_, i) => i % 2 === 1)
    const { parent, child } = buildChildScenario({
      parentOnly,
      childOnly,
      shared: [],
    })
    await parent.init()
    await child.init()

    for (const key of parentOnly) {
      expect(child.get(token<string>(key)))
        .toBe(`parent-${key}`)
      expect(parent.get(token<string>(key)))
        .toBe(`parent-${key}`)
    }
  })

  it.prop([fc.uniqueArray(fc.string({ minLength: 1, maxLength: 8 }), { minLength: 1, maxLength: 4 })], { numRuns: 50 })(
    'shadowed keys resolve child value while parent stays unchanged',
    async sharedKeys => {
      const shared = sharedKeys.map(key => ({
        key,
        parentValue: `parent-${key}`,
        childValue: `child-${key}`,
      }))

      const { parent, child } = buildChildScenario({ parentOnly: [], childOnly: [], shared })
      await parent.init()
      await child.init()

      for (const entry of shared) {
        expect(child.get(token<string>(entry.key)))
          .toBe(entry.childValue)
        expect(parent.get(token<string>(entry.key)))
          .toBe(entry.parentValue)
      }
    },
  )
})

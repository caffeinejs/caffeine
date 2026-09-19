import { fc, it } from '@fast-check/vitest'
import { describe, expect } from 'vitest'

import { deepEquals, reconcile } from '../reconcile.js'

// Few keys and small values, so that independently generated trees are often equal, or differ in one place.
const key = fc.constantFrom('a', 'b', 'c')
const scalar = fc.oneof(fc.constantFrom('x', 'y'), fc.integer({ min: 0, max: 1 }), fc.boolean(), fc.constant(null))

const { tree } = fc.letrec<{ tree: Record<string, unknown>; value: unknown }>(tie => ({
  tree: fc.dictionary(key, tie('value'), { maxKeys: 3 }),
  value: fc.oneof({ depthIdentifier: 'config', maxDepth: 3 }, scalar, fc.array(scalar, { maxLength: 2 }), tie('tree')),
}))

describe('deepEquals (property)', () => {
  // The store decides whether a source changed with `deepEquals`, and what changed with `reconcile`. Were they ever
  // to disagree, a reload would skip data that changed, or swap in a revision where nothing did.
  it.prop([tree, tree])('agrees with reconcile finding nothing that differs', (a, b) => {
    expect(deepEquals(a, b)).toBe(reconcile(a, b) === a)
  })

  it.prop([tree])('holds for a tree and a copy of it', a => {
    expect(deepEquals(a, structuredClone(a))).toBe(true)
  })
})

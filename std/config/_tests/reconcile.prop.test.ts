import { fc, it } from '@fast-check/vitest'
import { describe, expect } from 'vitest'

import { changedPaths, deepEquals } from '../reconcile.js'
import { readPath, toParts } from '../tree.js'

// Few keys and small values, so that independently generated trees are often equal, or differ in one place.
const key = fc.constantFrom('a', 'b', 'c')
const scalar = fc.oneof(fc.constantFrom('x', 'y'), fc.integer({ min: 0, max: 1 }), fc.boolean(), fc.constant(null))

const { tree } = fc.letrec<{ tree: Record<string, unknown>; value: unknown }>(tie => ({
  tree: fc.dictionary(key, tie('value'), { maxKeys: 3 }),
  value: fc.oneof({ depthIdentifier: 'config', maxDepth: 3 }, scalar, fc.array(scalar, { maxLength: 2 }), tie('tree')),
}))

describe('changedPaths (property)', () => {
  // The store skips a source whose data `deepEquals` the last, and decides a reload changed nothing when
  // `changedPaths` is empty. Were they ever to disagree, a reload would skip data that changed, or swap in a
  // revision where nothing did.
  it.prop([tree, tree])('is empty exactly when the trees are deep-equal', (a, b) => {
    expect(changedPaths(a, b).length === 0).toBe(deepEquals(a, b))
  })

  it.prop([tree])('is empty for a tree and a copy of it', a => {
    expect(changedPaths(a, structuredClone(a))).toEqual([])
  })

  it.prop([tree, tree])('names only paths whose values differ', (a, b) => {
    for (const path of changedPaths(a, b)) {
      expect(deepEquals(readPath(a, toParts(path)), readPath(b, toParts(path)))).toBe(false)
    }
  })
})

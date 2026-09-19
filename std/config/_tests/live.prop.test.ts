import { fc, it } from '@fast-check/vitest'
import { describe, expect } from 'vitest'

import { createLive, syncLive } from '../live.js'
import { reconcile } from '../reconcile.js'
import { freezeDeep } from '../tree.js'

const key = fc.constantFrom('a', 'b', 'c', 'd')
const scalar = fc.oneof(fc.string({ maxLength: 3 }), fc.integer({ min: -3, max: 3 }), fc.boolean(), fc.constant(null))

const { tree } = fc.letrec<{ tree: Record<string, unknown>; value: unknown }>(tie => ({
  tree: fc.dictionary(key, tie('value'), { maxKeys: 4 }),
  value: fc.oneof({ depthIdentifier: 'config', maxDepth: 3 }, scalar, fc.array(scalar, { maxLength: 3 }), tie('tree')),
}))

describe('the live config object (property)', () => {
  // Keys appear and disappear, leaves become objects and objects become leaves, in any order: whatever happened,
  // the object reads exactly the last snapshot it was synced to.
  it.prop([tree, fc.array(tree, { minLength: 1, maxLength: 6 })])(
    'reads the last snapshot after any sequence of syncs',
    (first, rest) => {
      const live = createLive(freezeDeep(structuredClone(first)))

      for (const next of rest) {
        syncLive(live, freezeDeep(structuredClone(next)))
      }

      expect(JSON.parse(JSON.stringify(live))).toEqual(rest[rest.length - 1])
    },
  )

  // The store syncs reconciled snapshots, which share unchanged subtrees with the previous one. Skipping a shared
  // subtree must never leave the object behind.
  it.prop([tree, fc.array(tree, { minLength: 1, maxLength: 6 })])(
    'reads the last snapshot when the snapshots share subtrees',
    (first, rest) => {
      let current = freezeDeep(structuredClone(first))
      const live = createLive(current)

      for (const next of rest) {
        current = freezeDeep(reconcile(current, structuredClone(next)))
        syncLive(live, current)
      }

      expect(JSON.parse(JSON.stringify(live))).toEqual(current)
    },
  )
})

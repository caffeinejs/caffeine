import { fc, it } from '@fast-check/vitest'
import { describe, expect } from 'vitest'

import { deepEquals, reconcile } from '../reconcile.js'
import { freezeCopy, isPlainObject, readPath, toParts } from '../tree.js'

// Few keys and small values, so that independently generated trees are often equal, or differ in one place.
const key = fc.constantFrom('a', 'b', 'c')
const scalar = fc.oneof(fc.constantFrom('x', 'y'), fc.integer({ min: 0, max: 1 }), fc.boolean(), fc.constant(null))

const { tree } = fc.letrec<{ tree: Record<string, unknown>; value: unknown }>(tie => ({
  tree: fc.dictionary(key, tie('value'), { maxKeys: 3 }),
  value: fc.oneof({ depthIdentifier: 'config', maxDepth: 3 }, scalar, fc.array(scalar, { maxLength: 2 }), tie('tree')),
}))

function changedPaths(previous: unknown, next: unknown): string[] {
  const changed: string[] = []
  reconcile(previous, next, changed)
  return changed
}

/** Whether every subtree of `next` deep-equal to its counterpart in `previous` is that counterpart. */
function sharesUnchanged(previous: unknown, next: unknown): boolean {
  if (deepEquals(previous, next)) {
    return Object.is(previous, next)
  }
  if (!isPlainObject(previous) || !isPlainObject(next)) {
    return true
  }
  return Object.keys(next).every(k => !Object.hasOwn(previous, k) || sharesUnchanged(previous[k], next[k]))
}

function frozenDeep(value: unknown): boolean {
  return (
    value === null || typeof value !== 'object' || (Object.isFrozen(value) && Object.values(value).every(frozenDeep))
  )
}

describe('reconcile: the changed paths (property)', () => {
  // The store skips a source whose data `deepEquals` the last, and decides a reload changed nothing when no path
  // changed. Were they ever to disagree, a reload would skip data that changed, or swap in a revision where nothing
  // did.
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

describe('reconcile: the next snapshot (property)', () => {
  // What a reload swaps in: it must hold what validation produced, frozen like the first snapshot, and share every
  // subtree that did not change, or a reader comparing identities would see a change where there was none.
  it.prop([tree, tree])('holds next, frozen, sharing every subtree that did not change', (a, b) => {
    const previous = freezeCopy(a)
    const next = reconcile(previous, b, [])

    expect(deepEquals(next, b)).toBe(true)
    expect(frozenDeep(next)).toBe(true)
    expect(sharesUnchanged(previous, next)).toBe(true)
  })

  it.prop([tree, tree])('is previous itself exactly when no path changed', (a, b) => {
    const previous = freezeCopy(a)
    const changed: string[] = []

    expect(reconcile(previous, b, changed) === previous).toBe(changed.length === 0)
  })
})

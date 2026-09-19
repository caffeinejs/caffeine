import { fc, it } from '@fast-check/vitest'
import { describe, expect } from 'vitest'

import { mergeLayers } from '../merge.js'
import { reconcile } from '../reconcile.js'
import { freezeDeep, isPlainObject, readPath } from '../tree.js'
import type { ConfigLayer, ConfigObject } from '../types.js'

// Few keys, so that independently generated trees overlap and the merge has conflicts to settle.
const key = fc.constantFrom('a', 'b', 'c', 'd')
const scalar = fc.oneof(fc.string({ maxLength: 3 }), fc.integer({ min: -3, max: 3 }), fc.boolean(), fc.constant(null))

const { tree } = fc.letrec<{ tree: Record<string, unknown>; value: unknown }>(tie => ({
  tree: fc.dictionary(key, tie('value'), { maxKeys: 4 }),
  value: fc.oneof({ depthIdentifier: 'config', maxDepth: 3 }, scalar, fc.array(scalar, { maxLength: 3 }), tie('tree')),
}))

function layer(data: Record<string, unknown>): ConfigLayer {
  return { name: 'layer', data: freezeDeep(structuredClone(data)) as ConfigObject }
}

function merge(...data: Record<string, unknown>[]): Record<string, unknown> {
  return mergeLayers(data.map(layer)) as Record<string, unknown>
}

/** Every path in `data` that holds something other than a plain object: what a layer says outright. */
function stated(data: Record<string, unknown>, prefix: string[] = []): [string[], unknown][] {
  const out: [string[], unknown][] = []
  for (const [k, v] of Object.entries(data)) {
    if (isPlainObject(v)) {
      out.push(...stated(v, [...prefix, k]))
    } else {
      out.push([[...prefix, k], v])
    }
  }
  return out
}

describe('mergeLayers (property)', () => {
  // Not associative, and rightly so: when `b` replaces an object with a scalar and `c` brings an object back,
  // folding `b` and `c` first would let `a`'s object show through the value `b` replaced.
  it.prop([tree, tree, tree])('equals merging the layers one at a time, in order', (a, b, c) => {
    expect(merge(a, b, c)).toEqual(merge(merge(a, b), c))
  })

  it('is not associative when a middle layer replaces an object', () => {
    const a = { x: { p: 1 } }
    const b = { x: 7 }
    const c = { x: { q: 2 } }

    expect(merge(a, b, c)).toEqual({ x: { q: 2 } })
    expect(merge(a, merge(b, c))).toEqual({ x: { p: 1, q: 2 } })
  })

  it.prop([tree, tree])('lets the later layer win every value it states', (a, b) => {
    const result = merge(a, b)

    for (const [path, value] of stated(b)) {
      expect(readPath(result, path)).toEqual(value)
    }
  })

  // An array is replaced whole: never longer than the one the later layer stated, never mixed with the earlier one.
  it.prop([tree, tree])('never merges arrays element by element', (a, b) => {
    const result = merge(a, b)

    for (const [path, value] of stated(b)) {
      if (Array.isArray(value)) {
        expect(readPath(result, path)).toStrictEqual(value)
      }
    }
  })

  it.prop([tree])('is the identity for one layer', a => {
    expect(merge(a)).toEqual(a)
  })
})

describe('reconcile (property)', () => {
  it.prop([tree, tree])('returns a value deep-equal to next', (a, b) => {
    expect(reconcile(a, b)).toEqual(b)
  })

  it.prop([tree])('returns previous itself when previous deep-equals next', a => {
    expect(reconcile(a, structuredClone(a))).toBe(a)
  })

  it.prop([tree, tree])('reports a change exactly when the trees differ', (a, b) => {
    const changed: string[] = []
    const result = reconcile(a, b, changed)

    expect(changed.length === 0).toBe(result === a)
  })
})

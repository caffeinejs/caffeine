import { describe, it, expect } from 'vitest'

import { mergeValue } from './_merge.js'
import { RouteBuilder } from './builder.js'

// The seam a package annotates a route through. Augmented here so the merge semantics below are pinned
// against a real namespace rather than a cast.
declare module './spec.js' {
  interface RouteDetail {
    testMerge?: unknown
  }
}

describe('mergeValue', () => {
  it('merges objects', () => {
    expect(mergeValue({ origin: 'http://a.com' }, { methods: ['GET'] })).toEqual({
      origin: 'http://a.com',
      methods: ['GET'],
    })
  })

  it('overwrites a primitive', () => {
    expect(mergeValue(1, 2)).toBe(2)
  })

  // Only a plain object merges member by member: a RegExp or a Date would come out as `{}`.
  it('replaces an object that is not plain with the incoming one', () => {
    const incoming = /two/

    expect(mergeValue(/one/, incoming)).toBe(incoming)
  })

  // A value below the top level is carried through as it is: a plugin's metadata may refer to itself.
  it('carries a value that refers to itself through unchanged', () => {
    const tree: Record<string, unknown> = { name: 'root' }
    tree.self = tree

    const merged = mergeValue({ a: 1 }, { tree }) as Record<string, unknown>

    expect(merged.tree).toBe(tree)
    expect(mergeValue(undefined, tree)).toBe(tree)
  })

  it('overwrites on type mismatch', () => {
    expect(mergeValue({ threshold: 100 }, false)).toBe(false)
  })

  // An object read from configuration may carry an own `__proto__`: it must not become the merged object's prototype.
  it('keeps an own __proto__ key from becoming the merged object’s prototype', () => {
    const merged = mergeValue({ a: 1 }, JSON.parse('{"__proto__":{"exempt":true}}')) as Record<string, unknown>

    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype)
    expect(merged.exempt).toBe(undefined)
  })
})

describe('RouteBuilder detail merge', () => {
  it('concats arrays on the same detail namespace', () => {
    const route = new RouteBuilder().detail('testMerge', [1, 2]).detail('testMerge', [3]).toRoute()

    expect(route.detail?.testMerge).toEqual([1, 2, 3])
  })

  it('overwrites on primitive detail namespace', () => {
    const route = new RouteBuilder().detail('testMerge', true).detail('testMerge', false).toRoute()

    expect(route.detail?.testMerge).toBe(false)
  })
})

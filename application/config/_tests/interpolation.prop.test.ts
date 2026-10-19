import { fc, it } from '@fast-check/vitest'
import { describe, expect } from 'vitest'

import { mergeInterpolated } from '../interpolation.js'
import { mergeLayers } from '../merge.js'
import { freezeDeep } from '../tree.js'
import type { ConfigLayer, ConfigObject } from '../types.js'

// The characters the syntax is made of, so that generated text keeps brushing against it.
const text = fc.string({ unit: fc.constantFrom('a', '$', '{', '}', ':', '-', ' '), maxLength: 8 })

// Few keys, so that independently generated trees overlap and the merge has conflicts to settle.
const key = fc.constantFrom('a', 'b', 'c', 'd')
const scalar = fc.oneof(
  text.filter(value => !value.includes('${')),
  fc.integer({ min: -3, max: 3 }),
  fc.boolean(),
  fc.constant(null),
)

const { tree } = fc.letrec<{ tree: Record<string, unknown>; value: unknown }>(tie => ({
  tree: fc.dictionary(key, tie('value'), { maxKeys: 4 }),
  value: fc.oneof({ depthIdentifier: 'config', maxDepth: 3 }, scalar, fc.array(scalar, { maxLength: 3 }), tie('tree')),
}))

function layer(data: Record<string, unknown>, interpolate: boolean): ConfigLayer {
  return { name: 'layer', data: freezeDeep(structuredClone(data)) as ConfigObject, interpolate }
}

/** Writes `value` so that interpolation gives it back: every run of `$` right before `{` doubled. */
function escape(value: string): string {
  let out = ''
  let run = ''

  for (const char of value) {
    if (char === '$') {
      run += char
    } else {
      out += char === '{' ? run + run + char : run + char
      run = ''
    }
  }

  return out + run
}

describe('mergeInterpolated (property)', () => {
  // Interpolation is on by default, so a file without placeholders must merge exactly as it did before it existed.
  it.prop([tree, fc.boolean(), tree, fc.boolean()])(
    'merges as mergeLayers does when no string holds ${',
    (a, interpolatesA, b, interpolatesB) => {
      const layers = [layer(a, interpolatesA), layer(b, interpolatesB)]

      expect(mergeInterpolated(layers, {})).toEqual(mergeLayers(layers))
    },
  )

  // Whatever text an author means, there is a way to write it.
  it.prop([text])('gives back any text written with its runs of $ before { doubled', value => {
    expect(mergeInterpolated([layer({ a: escape(value) }, true)], {})).toEqual({ a: value })
  })
})

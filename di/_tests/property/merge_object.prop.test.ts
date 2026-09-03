import { it, fc } from '@fast-check/vitest'
import { describe, expect } from 'vitest'

import { mergeObject } from '../../internal/util/objects/objects.js'

const safeKey = fc.string().filter(s => s !== '__proto__' && s !== 'constructor' && s !== 'prototype')

describe('mergeObject (property)', function () {
  it.prop([fc.dictionary(safeKey, fc.string()), fc.dictionary(safeKey, fc.string())])(
    'should override value keys when other has non-undefined values',
    (value, other) => {
      const result = mergeObject<Record<string, string>>(value, other)

      for (const key of Object.keys(other)) {
        if (other[key] !== undefined) {
          expect(result[key]).toBe(other[key])
        }
      }
    },
  )

  it.prop([fc.dictionary(safeKey, fc.string()), fc.dictionary(safeKey, fc.string())])(
    'should preserve value keys when other has undefined',
    (value, other) => {
      const result = mergeObject<Record<string, string>>(value, other)

      for (const key of Object.keys(value)) {
        if (other[key] === undefined) {
          expect(result[key]).toBe(value[key])
        }
      }
    },
  )

  it.prop([fc.dictionary(safeKey, fc.string()), fc.dictionary(safeKey, fc.string())])(
    'should include all keys from both objects',
    (value, other) => {
      const result = mergeObject<Record<string, string>>(value, other)
      const keys = new Set([...Object.keys(value), ...Object.keys(other)])

      expect(Object.keys(result).sort()).toEqual([...keys].sort())
    },
  )

  it.prop([fc.array(fc.nat(), { minLength: 1, maxLength: 5 }), fc.array(fc.nat(), { minLength: 1, maxLength: 5 })])(
    'should preserve symbol-keyed properties from both objects',
    (valueNums, otherNums) => {
      const value: Record<string | symbol, number> = {}
      const other: Record<string | symbol, number> = {}
      const valueSyms = valueNums.map(n => Symbol(`v${n}`))
      const otherSyms = otherNums.map(n => Symbol(`o${n}`))

      for (let i = 0; i < valueSyms.length; i++) {
        value[valueSyms[i]!] = valueNums[i]!
      }

      for (let i = 0; i < otherSyms.length; i++) {
        other[otherSyms[i]!] = otherNums[i]!
      }

      const result = mergeObject<Record<string | symbol, number>>(value, other)

      for (let i = 0; i < valueSyms.length; i++) {
        const sym = valueSyms[i]!
        if (other[sym] === undefined) {
          expect(result[sym]).toBe(valueNums[i])
        }
      }

      for (let i = 0; i < otherSyms.length; i++) {
        const sym = otherSyms[i]!
        if (other[sym] !== undefined) {
          expect(result[sym]).toBe(otherNums[i])
        }
      }
    },
  )
})

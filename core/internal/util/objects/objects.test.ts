import { describe, it, expect } from 'vitest'
import { mergeObject } from './objects.js'

describe('mergeObject', function () {
  it('should preserve Symbol-keyed properties from both objects', function () {
    const kA = Symbol('a')
    const kB = Symbol('b')

    const result = mergeObject<any>({ [kA]: 1 }, { [kB]: 2 })

    expect(result[kA])
      .toBe(1)
    expect(result[kB])
      .toBe(2)
  })

  it('should use other value when both have the same Symbol key and other is not nil', function () {
    const k = Symbol('shared')

    const result = mergeObject<any>({ [k]: 'original' }, { [k]: 'override' })

    expect(result[k])
      .toBe('override')
  })

  it('should keep value when other Symbol key is undefined', function () {
    const k = Symbol('k')

    const result = mergeObject<any>({ [k]: 'keep' }, { [k]: undefined })

    expect(result[k])
      .toBe('keep')
  })
})

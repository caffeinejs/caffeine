import { describe, it, expect } from 'vitest'
import { Injectable } from '../decorators/injectable.js'
import { Named } from '../decorators/named.js'
import { CaffeineIoC } from '../container.js'
import { optional } from '../injection.js'

describe('CaffeineIoC', function () {
  const kTestName = Symbol('test-name')

  @Injectable()
  class Test {}

  @Injectable()
  class Dep {}

  class Opt {}

  @Injectable([Dep, optional(Opt)])
  @Named(kTestName)
  class NamedTest {
    constructor(
      readonly dep: Dep,
      readonly opt?: Opt,
    ) {}
  }

  it('should print the type name when calling toString()', function () {
    const di = new CaffeineIoC()
    di.bind('tk100')
      .toValue('test')
    di.bind('tk200')
      .toValue('test')

    const str = di.toString()
    const protoStr = Object.prototype.toString.call(di)

    expect(str)
      .toContain('Test')
    expect(str)
      .toContain('NamedTest')
    expect(str)
      .toContain(kTestName.description)
    expect(str)
      .toContain('tk100')
    expect(str)
      .toContain('tk200')
    expect(protoStr)
      .toEqual('[object CaffeineIoC]')
  })

  it('should support iteration via entries() and direct Symbol.iterator', function () {
    const di = new CaffeineIoC()

    for (const [key, binding] of di.entries()) {
      expect(key)
        .toBeDefined()
      expect(binding)
        .toBeDefined()
    }
    for (const [key, binding] of di) {
      expect(key)
        .toBeDefined()
      expect(binding)
        .toBeDefined()
    }

    const fromEntries = new Map(di.entries())
    const fromIterator = new Map(di)

    expect(fromEntries.has(Test))
      .toBeTruthy()
    expect(fromEntries.has(NamedTest))
      .toBeTruthy()
    expect(fromIterator.has(NamedTest))
      .toBeTruthy()
    expect(fromEntries.get(NamedTest)?.names)
      .toContain(kTestName)
    expect(fromEntries.size)
      .toEqual(di.size)
    expect(fromIterator.size)
      .toEqual(di.size)
  })

  // This test considers ALL injectable defined in this test file
  // --
  it('should return the number of registered components when calling size()', function () {
    const di = new CaffeineIoC()
    const userDefined = 3 // all injectables in this file
    const internal = 1 // the internal components (request scope manager is not enabled in this test)
    const expected = userDefined + internal

    di.autoWire()
    di.autoWire()

    expect(di.size)
      .toEqual(expected)
  })
})

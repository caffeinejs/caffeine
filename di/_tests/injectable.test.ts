import { describe, it, expect } from 'vitest'
import { Injectable } from '../decorators/injectable.js'
import { CaffeineIoC } from '../container.js'

describe('@Injectable overloads', function () {
  it('should register with no arguments', async function () {
    @Injectable()
    class NoArgs {}

    const di = new CaffeineIoC()
    await di.init()
    expect(di.get(NoArgs))
      .toBeInstanceOf(NoArgs)
  })

  it('should register with a symbol qualifier key only', async function () {
    const kSvc = Symbol('svc')

    @Injectable(kSvc)
    class KeyOnly {}

    const di = new CaffeineIoC()
    await di.init()
    expect(di.get(kSvc))
      .toBeInstanceOf(KeyOnly)
  })

  it('should register with a string qualifier key only', async function () {
    @Injectable('myService')
    class StringKey {}

    const di = new CaffeineIoC()
    await di.init()
    expect(di.get('myService'))
      .toBeInstanceOf(StringKey)
  })

  it('should register with dependencies array only', async function () {
    @Injectable()
    class Dep {
      value = 42
    }

    @Injectable([Dep])
    class WithDeps {
      constructor(readonly dep: Dep) {}
    }

    const di = new CaffeineIoC()
    await di.init()
    const instance = di.get(WithDeps) as WithDeps
    expect(instance.dep)
      .toBeInstanceOf(Dep)
    expect(instance.dep.value)
      .toBe(42)
  })

  it('should register with a symbol key and dependencies', async function () {
    const kNamed = Symbol('named-with-deps')

    @Injectable()
    class Dependency {
      name = 'dep'
    }

    @Injectable(kNamed, [Dependency])
    class KeyAndDeps {
      constructor(readonly dep: Dependency) {}
    }

    const di = new CaffeineIoC()
    await di.init()
    const instance = di.get(kNamed) as KeyAndDeps
    expect(instance)
      .toBeInstanceOf(KeyAndDeps)
    expect(instance.dep.name)
      .toBe('dep')
  })

  it('should throw when a function type is passed as key', function () {
    expect(() => {
      @Injectable(class AbstractBase {} as unknown as symbol)
      class Wrong {}
    })
      .toThrow()
  })
})

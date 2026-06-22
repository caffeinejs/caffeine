import { describe, it, expect } from 'vitest'
import { Inject } from '../decorators/inject.js'
import { Injectable } from '../decorators/injectable.js'
import { Lazy } from '../decorators/lazy.js'
import { Named } from '../decorators/named.js'
import { DiCaf } from '../container.js'

describe('Property Injection', function () {
  const kValue = Symbol('value')
  const kNamedDep = Symbol('named-dep')

  @Injectable()
  class Dep {
    test() {
      return 'ok'
    }
  }

  interface Contract {
    run(): string
  }

  @Injectable()
  @Named(kNamedDep)
  class NamedDep implements Contract {
    run() {
      return 'ran'
    }
  }

  describe('when class has only property injections', function () {
    @Injectable()
    @Lazy()
    class PropertyOnly {
      @Inject(Dep)
      dep!: Dep

      @Inject(kValue)
      value!: string

      @Inject(kNamedDep)
      namedDep!: Contract

      constructor() {
        expect(this.dep)
          .toBeUndefined()
        expect(this.value)
          .toBeUndefined()
        expect(this.namedDep)
          .toBeUndefined()
      }
    }

    it('should construct class and resolve property dependencies', async function () {
      const di = new DiCaf()
      di.bind(kValue)
        .toValue('test')
      await di.init()

      const root = di.get(PropertyOnly)

      expect(root)
        .toBeInstanceOf(PropertyOnly)
      expect(root.dep)
        .toBeInstanceOf(Dep)
      expect(root.dep.test())
        .toEqual('ok')
      expect(root.value)
        .toEqual('test')
      expect(root.namedDep.run())
        .toEqual('ran')
    })
  })

  describe('when class has both constructor and property injections', function () {
    @Injectable([kNamedDep])
    @Lazy()
    class CtorAndProperties {
      @Inject(Dep)
      dep!: Dep

      @Inject(kValue)
      value!: string

      constructor(readonly namedDep: Contract) {
        expect(this.dep)
          .toBeUndefined()
        expect(this.value)
          .toBeUndefined()
        expect(this.namedDep)
          .toBeDefined()
      }
    }

    it('should instantiate class injecting constructor dependencies and then inject property dependencies', async function () {
      const di = new DiCaf()
      di.bind(kValue)
        .toValue('test')
      await di.init()

      const root = di.get(CtorAndProperties)

      expect(root)
        .toBeInstanceOf(CtorAndProperties)
      expect(root.dep)
        .toBeInstanceOf(Dep)
      expect(root.dep.test())
        .toEqual('ok')
      expect(root.value)
        .toEqual('test')
      expect(root.namedDep.run())
        .toEqual('ran')
    })
  })

  describe('when properties are private', function () {
    @Injectable()
    @Lazy()
    class PrivateTest {
      @Inject(Dep)
      private _dep!: Dep

      @Inject(kValue)
      private _value!: string

      #namedDep!: Contract

      constructor() {
        expect(this._dep)
          .toBeUndefined()
        expect(this._value)
          .toBeUndefined()
        expect(this.#namedDep)
          .toBeUndefined()
      }

      get dep(): Dep {
        return this._dep
      }

      get value(): string {
        return this._value
      }

      @Inject(kNamedDep)
      get namedDep(): Contract {
        return this.#namedDep
      }

      set namedDep(value: Contract) {
        this.#namedDep = value
      }
    }

    it('should inject values any type of private property', async function () {
      const di = new DiCaf()
      di.bind(kValue)
        .toValue('test')
      await di.init()

      const root = di.get(PrivateTest)

      expect(root)
        .toBeInstanceOf(PrivateTest)
      expect(root.dep)
        .toBeInstanceOf(Dep)
      expect(root.dep.test())
        .toEqual('ok')
      expect(root.value)
        .toEqual('test')
      expect(root.namedDep.run())
        .toEqual('ran')
    })
  })
})

import { describe, it, expect } from 'vitest'
import { Injectable } from '../decorators/injectable.js'
import { Inject } from '../decorators/inject.js'
import { CaffeineIoC } from '../container.js'
import { $i } from '../injection.js'
import { ErrInvalidBinding } from '../errors.js'

describe('class field injection', function () {
  // Shared deps registered via @Injectable at describe scope — visible to all tests in this file
  const kNone = Symbol('none')

  @Injectable()
  class DepA {
    greet() {
      return 'hello'
    }
  }

  @Injectable()
  class DepB {
    farewell() {
      return 'bye'
    }
  }

  @Injectable()
  class DepC {
    ping() {
      return 'pong'
    }
  }

  describe('decorator-based injection — mixed member kinds on one class', function () {
    // A single class using setter, field, getter (with backing setter), and auto-accessor
    // so the interceptor chain processes all four kinds in one pass.

    @Injectable()
    class Mixed {
      // setter injection
      private _setter!: DepA
      @Inject(DepA)
      set setter(v: DepA) {
        this._setter = v
      }

      get setter(): DepA {
        return this._setter
      }

      // field injection
      @Inject(DepB)
      field!: DepB

      // getter injection (getter + backing setter)
      #getter!: DepC
      @Inject(DepC)
      get getter(): DepC {
        return this.#getter
      }

      set getter(v: DepC) {
        this.#getter = v
      }

      // auto-accessor injection
      @Inject(DepA)
      accessor accessorDep!: DepA

      constructor() {
        // All members are undefined at construction time — injection runs after factory
        expect(this._setter)
          .toBeUndefined()
        expect(this.field)
          .toBeUndefined()
        expect(this.#getter)
          .toBeUndefined()
      }
    }

    it('should inject all member kinds after construction', async function () {
      const di = new CaffeineIoC()
      await di.init()

      const mixed = di.get(Mixed)

      expect(mixed)
        .toBeInstanceOf(Mixed)
      expect(mixed.setter)
        .toBeInstanceOf(DepA)
      expect(mixed.setter.greet())
        .toEqual('hello')
      expect(mixed.field)
        .toBeInstanceOf(DepB)
      expect(mixed.field.farewell())
        .toEqual('bye')
      expect(mixed.getter)
        .toBeInstanceOf(DepC)
      expect(mixed.getter.ping())
        .toEqual('pong')
      expect(mixed.accessorDep)
        .toBeInstanceOf(DepA)
    })
  })

  describe('decorator-based injection — mixed kinds with optional and absent deps', function () {
    // Class mixes required field, optional absent dep, and required setter —
    // exercises that the interceptor processes all entries regardless of kind order
    // and that an absent optional never causes the other injections to be skipped.

    @Injectable()
    class PartiallyOptional {
      // required field
      @Inject(DepA)
      fieldDep!: DepA

      // optional dep not bound to the container — must remain undefined
      @Inject($i.optional(kNone))
      optionalDep!: string | undefined

      // required setter
      private _setterDep!: DepB
      @Inject(DepB)
      set setterDep(v: DepB) {
        this._setterDep = v
      }

      get setterDep(): DepB {
        return this._setterDep
      }
    }

    it('should resolve required members and leave optional absent dep undefined', async function () {
      const di = new CaffeineIoC()
      await di.init()

      const instance = di.get(PartiallyOptional)

      expect(instance.fieldDep)
        .toBeInstanceOf(DepA)
      expect(instance.optionalDep)
        .toBeUndefined()
      expect(instance.setterDep)
        .toBeInstanceOf(DepB)
    })
  })

  describe('BinderOptions.injectProperty() — happy paths', function () {
    it('should inject a single required property on a manually-bound class', async function () {
      class ManualSvc {
        dep!: DepA
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bind(DepA)
        .toSelf()
      di.bind(ManualSvc)
        .toSelf()
        .injectProperty('dep', DepA)
      await di.init()

      const svc = di.get(ManualSvc)
      expect(svc)
        .toBeInstanceOf(ManualSvc)
      expect(svc.dep)
        .toBeInstanceOf(DepA)
      expect(svc.dep.greet())
        .toEqual('hello')
    })

    it('should support chaining multiple injectProperty() calls', async function () {
      class MultiField {
        fieldA!: DepA
        private _fieldB!: DepB
        set fieldB(v: DepB) {
          this._fieldB = v
        }

        get fieldB(): DepB {
          return this._fieldB
        }
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bind(DepA)
        .toSelf()
      di.bind(DepB)
        .toSelf()
      di.bind(MultiField)
        .toSelf()
        .injectProperty('fieldA', DepA)
        .injectProperty('fieldB', DepB)
      await di.init()

      const instance = di.get(MultiField)
      expect(instance.fieldA)
        .toBeInstanceOf(DepA)
      expect(instance.fieldB)
        .toBeInstanceOf(DepB)
    })

    it('should work alongside constructor injections', async function () {
      class WithCtor {
        fieldDep!: DepB

        constructor(readonly ctorDep: DepA) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bind(DepA)
        .toSelf()
      di.bind(DepB)
        .toSelf()
      di.bind(WithCtor)
        .toSelf([DepA])
        .injectProperty('fieldDep', DepB)
      await di.init()

      const instance = di.get(WithCtor)
      expect(instance.ctorDep)
        .toBeInstanceOf(DepA)
      expect(instance.fieldDep)
        .toBeInstanceOf(DepB)
    })

    it('should leave optional absent dep undefined', async function () {
      class WithOptional {
        required!: DepA
        absent!: DepC | undefined
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bind(DepA)
        .toSelf()
      // DepC is intentionally NOT bound
      di.bind(WithOptional)
        .toSelf()
        .injectProperty('required', DepA)
        .injectProperty('absent', $i.optional(DepC))
      await di.init()

      const instance = di.get(WithOptional)
      expect(instance.required)
        .toBeInstanceOf(DepA)
      expect(instance.absent)
        .toBeUndefined()
    })
  })

  describe('BinderOptions.injectProperty() — validation', function () {
    it('should throw ErrInvalidBinding when key is a symbol', function () {
      const kSym = Symbol('sym')
      const di = new CaffeineIoC({ decorators: false })

      expect(() => {
        di.bind(kSym)
          .toValue('x')
          .injectProperty('prop', DepA)
      })
        .toThrow(ErrInvalidBinding)
    })

    it('should throw ErrInvalidBinding when key is a string', function () {
      const di = new CaffeineIoC({ decorators: false })

      expect(() => {
        di.bind('stringKey')
          .toValue('x')
          .injectProperty('prop', DepA)
      })
        .toThrow(ErrInvalidBinding)
    })
  })
})

import { describe, it, beforeEach, expect, vi } from 'vitest'
import { ConditionalOn } from '../decorators/conditional_on.js'
import { Provides } from '../decorators/provides.js'
import { Injectable } from '../decorators/injectable.js'
import { CaffeineIoC } from '../container.js'
import { $i } from '../injection.js'
import { Configuration } from '../decorators/configuration.js'
import { ContainerBindingOps } from '../container_interface.js'

describe('Conditionals', function () {
  describe('using default conditional', function () {
    class NonManaged {}

    @Injectable()
    class Managed {}

    @Injectable()
    @ConditionalOn(ctx => ctx.container.has(NonManaged))
    class NoPass {}

    @Injectable()
    @ConditionalOn(ctx => ctx.container.has(NonManaged))
    @ConditionalOn(() => process.env.NODE === 'test')
    class NoPassToo {}

    @Injectable()
    @ConditionalOn(ctx => ctx.container.has(Managed))
    @ConditionalOn(() => true)
    class Pass {}

    @Injectable([Pass])
    class RefPassed {
      constructor(readonly pass: Pass) {}
    }

    @Injectable([$i.optional(NoPass)])
    class RefNotPassed {
      constructor(readonly noPass: NoPass | undefined) {}
    }
    void RefNotPassed

    @Injectable([$i.optional(NoPass)])
    class RefNotPassedOptional {
      constructor(readonly noPass?: NoPass) {}
    }

    it('should only register components that pass all provided conditionals', async function () {
      const di = new CaffeineIoC()

      expect(di.has(Pass))
        .toBeFalsy()
      expect(di.has(NoPass))
        .toBeFalsy()
      expect(di.has(NoPassToo))
        .toBeFalsy()

      await di.init()

      expect(di.has(Pass))
        .toBeTruthy()
      expect(di.has(NoPass))
        .toBeFalsy()
      expect(di.has(NoPassToo))
        .toBeFalsy()
    })

    it('should resolve components that pass conditionals and handle optional absent deps', async function () {
      const di = new CaffeineIoC({ decorators: false })
      di.bind(Managed)
        .toSelf()
      di.bind(Pass)
        .toSelf()
      di.bind(RefPassed)
        .toSelf([Pass])
      di.bind(RefNotPassedOptional)
        .toSelf([$i.optional(NoPass)])
      await di.init()

      const refPassed = di.get(RefPassed)
      const opt = di.get(RefNotPassedOptional)

      expect(refPassed)
        .toBeInstanceOf(RefPassed)
      expect(refPassed.pass)
        .toBeInstanceOf(Pass)
      expect(opt)
        .toBeInstanceOf(RefNotPassedOptional)
      expect(opt.noPass)
        .toBeUndefined()
    })
  })

  describe('conditional evaluated during container initialization - sees module and manual bindings', function () {
    it('should register a component whose conditional checks a module-registered binding', async function () {
      class ModuleSvc {}

      @Injectable()
      @ConditionalOn(ctx => ctx.container.has(ModuleSvc))
      class DependsOnModuleSvc {}

      const di = new CaffeineIoC((container: ContainerBindingOps) => {
        container.bind(ModuleSvc)
          .toSelf()
      })

      await di.init()

      expect(di.has(DependsOnModuleSvc))
        .toBeTruthy()
    })

    it('should not register a component when the checked binding is absent', async function () {
      class NeverBound {}

      @Injectable()
      @ConditionalOn(ctx => ctx.container.has(NeverBound))
      class DependsOnNeverBound {}

      const di = new CaffeineIoC()
      await di.init()

      expect(di.has(DependsOnNeverBound))
        .toBeFalsy()
    })
  })

  describe('async conditional functions', function () {
    it('should register a component when an async conditional resolves to true', async function () {
      @Injectable()
      @ConditionalOn(async () => true)
      class AsyncTrueBean {}

      const di = new CaffeineIoC()
      await di.init()

      expect(di.has(AsyncTrueBean))
        .toBeTruthy()
    })

    it('should not register a component when an async conditional resolves to false', async function () {
      @Injectable()
      @ConditionalOn(async () => false)
      class AsyncFalseBean {}

      const di = new CaffeineIoC()
      await di.init()

      expect(di.has(AsyncFalseBean))
        .toBeFalsy()
    })
  })

  describe('BinderOptions.conditional()', function () {
    it('should keep a manually-bound component when its conditional passes', async function () {
      class PresenceSvc {}
      class ConditionalSvc {}

      const di = new CaffeineIoC({ decorators: false })
      di.bind(PresenceSvc)
        .toSelf()
      di.bind(ConditionalSvc)
        .toSelf()
        .conditional(ctx => ctx.container.has(PresenceSvc))
      await di.init()

      expect(di.has(ConditionalSvc))
        .toBeTruthy()
      expect(di.get(ConditionalSvc))
        .toBeInstanceOf(ConditionalSvc)
    })

    it('should remove a manually-bound component when its conditional fails', async function () {
      class AbsentSvc {}
      class ConditionalSvcFailing {}

      const di = new CaffeineIoC({ decorators: false })
      di.bind(ConditionalSvcFailing)
        .toSelf()
        .conditional(ctx => ctx.container.has(AbsentSvc))
      await di.init()

      expect(di.has(ConditionalSvcFailing))
        .toBeFalsy()
    })

    it('should support async conditional functions', async function () {
      class AsyncConditionalSvc {}

      const di = new CaffeineIoC({ decorators: false })
      di.bind(AsyncConditionalSvc)
        .toSelf()
        .conditional(async () => true)
      await di.init()

      expect(di.has(AsyncConditionalSvc))
        .toBeTruthy()
      expect(di.get(AsyncConditionalSvc))
        .toBeInstanceOf(AsyncConditionalSvc)
    })
  })

  describe('conditional @Configuration cascade', function () {
    it('should skip all provides of a configuration class that fails its conditional', async function () {
      const kCascadedProvide = Symbol('cascadedProvide')

      @Configuration()
      @ConditionalOn(() => false)
      class FailingConf {
        @Provides(kCascadedProvide)
        provided() {
          return 'value'
        }
      }
      void FailingConf

      const di = new CaffeineIoC()
      await di.init()

      expect(di.has(FailingConf))
        .toBeFalsy()
      expect(di.has(kCascadedProvide))
        .toBeFalsy()
    })

    it('should register all provides of a configuration class that passes its conditional', async function () {
      const kPassingProvide = Symbol('passingProvide')

      @Configuration()
      @ConditionalOn(() => true)
      class PassingConf {
        @Provides(kPassingProvide)
        provided() {
          return 'value'
        }
      }
      void PassingConf

      const di = new CaffeineIoC()
      await di.init()

      expect(di.has(PassingConf))
        .toBeTruthy()
      expect(di.has(kPassingProvide))
        .toBeTruthy()
      expect(di.get(kPassingProvide))
        .toEqual('value')
    })
  })

  describe('using on configuration class', function () {
    describe('and using the decorator on class level', function () {
      const spy1 = vi.fn()
      const spy2 = vi.fn()

      const kTxt = Symbol('txt')
      const kVal = Symbol('val')
      const kJson = Symbol('json')
      const kXml = Symbol('xml')

      @Configuration()
      @ConditionalOn(() => {
        spy1()
        return false
      })
      class NoConf {
        @Provides(kTxt)
        @ConditionalOn(() => {
          spy1()
          return true
        })
        txt() {
          return 'txt'
        }

        @Provides(kVal)
        val() {
          return 'val'
        }
      }

      @Configuration()
      @ConditionalOn(() => {
        spy2()
        return true
      })
      class Conf {
        @Provides(kJson)
        @ConditionalOn(() => {
          spy2()
          return true
        })
        @ConditionalOn(() => {
          spy2()
          return true
        })
        json() {
          return 'json'
        }

        @Provides(kXml)
        @ConditionalOn(() => {
          spy2()
          return false
        })
        @ConditionalOn(() => {
          spy2()
          return true
        })
        xml() {
          return 'xml'
        }
      }

      beforeEach(() => {
        spy1.mockReset()
        spy2.mockReset()
      })

      it('should merge the conditionals from class and method level', async function () {
        const di = new CaffeineIoC()
        await di.init()

        expect(di.has(NoConf))
          .toBeFalsy()
        expect(di.has(kTxt))
          .toBeFalsy()
        expect(di.has(kVal))
          .toBeFalsy()
        expect(spy1)
          .toHaveBeenCalledTimes(1)

        expect(di.has(Conf))
          .toBeTruthy()
        expect(di.has(kJson))
          .toBeTruthy()
        expect(di.has(kXml))
          .toBeFalsy()
        expect(spy2)
          .toHaveBeenCalledTimes(4)
      })
    })
  })
})

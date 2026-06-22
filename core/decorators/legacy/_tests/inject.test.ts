import 'reflect-metadata'
import { describe, it, beforeAll, expect } from 'vitest'
import { DiCaf } from '../../../container.js'
import { Injectable } from '../injectable.js'
import { Inject } from '../inject.js'

describe('Legacy @Inject', function () {
  describe('property injection', function () {
    @Injectable()
    class Repo {
      find() {
        return ['item1', 'item2']
      }
    }

    @Injectable()
    class Service {
      @Inject(Repo)
      repo!: Repo

      list() {
        return this.repo.find()
      }
    }

    const di = new DiCaf()

    beforeAll(async () => {
      await di.init()
    })

    it('injects property', function () {
      const svc = di.get(Service)
      expect(svc.repo)
        .toBeInstanceOf(Repo)
      expect(svc.list())
        .toEqual(['item1', 'item2'])
    })
  })

  describe('method injection', function () {
    @Injectable()
    class Logger {
      log(msg: string) {
        return `log:${msg}`
      }
    }

    @Injectable()
    class Handler {
      private logger!: Logger

      @Inject([Logger])
      init(logger: Logger) {
        this.logger = logger
      }

      handle() {
        return this.logger.log('handled')
      }
    }

    const di = new DiCaf()

    beforeAll(async () => {
      await di.init()
    })

    it('injects via method', function () {
      const handler = di.get(Handler)
      expect(handler.handle())
        .toBe('log:handled')
    })
  })

  describe('named property injection', function () {
    const KEY = 'legacy-named-prop'

    @Injectable(KEY)
    class Impl {
      value() {
        return 'named-value'
      }
    }

    @Injectable()
    class Consumer {
      @Inject(KEY)
      dep!: Impl

      get() {
        return this.dep.value()
      }
    }

    const di = new DiCaf()

    beforeAll(async () => {
      await di.init()
    })

    it('injects by named key', function () {
      const c = di.get(Consumer)
      expect(c.get())
        .toBe('named-value')
    })
  })

  describe('error paths', function () {
    it('throws when @Inject used as member decorator without propertyKey', function () {
      class Dep {}
      expect(() => {
        Inject(Dep)(class Target {}, undefined, undefined)
      }).toThrow()
    })

    it('throws when @Inject on a method receives a non-array key', function () {
      class Dep {}
      expect(() => {
        Inject(Dep)({}, 'method', { value: function () {} } as PropertyDescriptor)
      }).toThrow()
    })
  })
})

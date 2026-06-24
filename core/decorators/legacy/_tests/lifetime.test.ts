import 'reflect-metadata'
import { describe, it, beforeAll, expect } from 'vitest'
import { CaffeineIoC } from '../../../container.js'
import { Scopes } from '../../../scope.js'
import { Injectable } from '../injectable.legacy.js'
import { Lifetime } from '../lifetime.legacy.js'

describe('Legacy lifetime decorators', function () {
  describe('@Singleton', function () {
    @Lifetime(Scopes.SINGLETON)
    @Injectable()
    class SingletonSvc {
      readonly id = Math.random()
    }

    const di = new CaffeineIoC()

    beforeAll(async () => {
      await di.init()
    })

    it('returns same instance', function () {
      expect(di.get(SingletonSvc))
        .toBe(di.get(SingletonSvc))
    })
  })

  describe('@Transient', function () {
    @Lifetime(Scopes.TRANSIENT)
    @Injectable()
    class TransientSvc {
      readonly id = Math.random()
    }

    const di = new CaffeineIoC()

    beforeAll(async () => {
      await di.init()
    })

    it('returns new instance each time', function () {
      const a = di.get(TransientSvc)
      const b = di.get(TransientSvc)
      expect(a).not.toBe(b)
      expect(a.id).not.toBe(b.id)
    })
  })

  describe('@Lifetime with explicit scope', function () {
    @Lifetime(Scopes.TRANSIENT)
    @Injectable()
    class LifetimeSvc {
      readonly id = Math.random()
    }

    const di = new CaffeineIoC()

    beforeAll(async () => {
      await di.init()
    })

    it('applies scope from @Lifetime', function () {
      const a = di.get(LifetimeSvc)
      const b = di.get(LifetimeSvc)
      expect(a).not.toBe(b)
    })
  })
})

import 'reflect-metadata'
import { describe, it, beforeAll, expect, vi } from 'vitest'
import { DiCaf } from '../../../container.js'
import { Injectable } from '../injectable.js'
import { Configuration } from '../configuration.js'
import { Provides } from '../provides.js'
import { Lazy } from '../lazy.js'

describe('Legacy @Lazy', function () {
  describe('class-level lazy', function () {
    const spy = vi.fn()

    @Lazy()
    @Injectable()
    class LazyClass {
      constructor() {
        spy()
      }
    }

    const di = new DiCaf()

    beforeAll(async () => {
      await di.init()
    })

    it('binding is marked lazy', function () {
      expect(di.getBinding(LazyClass).lazy).toBe(true)
    })

    it('does not instantiate during init', function () {
      expect(spy).not.toHaveBeenCalled()
    })

    it('instantiates on first get', function () {
      const svc = di.get(LazyClass)
      expect(svc).toBeInstanceOf(LazyClass)
      expect(spy).toHaveBeenCalledTimes(1)
    })

    it('returns same singleton instance on subsequent gets', function () {
      const a = di.get(LazyClass)
      const b = di.get(LazyClass)
      expect(a).toBe(b)
    })
  })

  describe('member-level lazy on @Provides', function () {
    const spy = vi.fn()

    class LazyBean {
      constructor() {
        spy()
      }
    }

    @Configuration()
    class LazyConf {
      @Lazy()
      @Provides(LazyBean)
      bean(): LazyBean {
        return new LazyBean()
      }
    }

    void LazyConf

    const di = new DiCaf()

    beforeAll(async () => {
      await di.init()
    })

    it('@Provides binding is marked lazy', function () {
      expect(di.getBinding(LazyBean).lazy).toBe(true)
    })

    it('does not call @Provides factory during init', function () {
      expect(spy).not.toHaveBeenCalled()
    })

    it('calls @Provides factory on first get', function () {
      const bean = di.get(LazyBean)
      expect(bean).toBeInstanceOf(LazyBean)
      expect(spy).toHaveBeenCalledTimes(1)
    })
  })

  describe('@Lazy(false)', function () {
    @Lazy(false)
    @Injectable()
    class NonLazyClass {}

    const di = new DiCaf()

    beforeAll(async () => {
      await di.init()
    })

    it('binding is not marked lazy when @Lazy(false)', function () {
      expect(di.getBinding(NonLazyClass).lazy).toBe(false)
    })
  })
})

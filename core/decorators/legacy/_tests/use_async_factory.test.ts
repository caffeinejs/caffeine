import 'reflect-metadata'
import { describe, it, beforeAll, expect } from 'vitest'
import { CaffeineIoC } from '../../../container.js'
import { Injectable } from '../injectable.legacy.js'
import { UseAsyncFactory } from '../use_async_factory.legacy.js'

describe('Legacy @UseAsyncFactory', function () {
  describe('basic async factory', function () {
    @UseAsyncFactory(async () => {
      const b = new AsyncBean()
      b.builtBy = 'async-factory'
      return b
    })
    @Injectable()
    class AsyncBean {
      builtBy = 'constructor'
    }

    const di = new CaffeineIoC()

    beforeAll(async () => {
      await di.init()
    })

    it('resolves to factory-produced instance after init', function () {
      const bean = di.get(AsyncBean)
      expect(bean).toBeInstanceOf(AsyncBean)
      expect(bean.builtBy).toBe('async-factory')
    })

    it('binding is marked async', function () {
      expect(di.getBinding(AsyncBean).async).toBe(true)
    })

    it('same singleton instance returned on each get', function () {
      const a = di.get(AsyncBean)
      const b = di.get(AsyncBean)
      expect(a).toBe(b)
    })
  })

  describe('async factory with promise-based setup', function () {
    @UseAsyncFactory(async () => {
      const val = await Promise.resolve('resolved')
      const b = new PromiseBean()
      b.value = val
      return b
    })
    @Injectable()
    class PromiseBean {
      value = ''
    }

    const di = new CaffeineIoC()

    beforeAll(async () => {
      await di.init()
    })

    it('awaits async factory and caches result', function () {
      const res = di.get(PromiseBean)
      expect(res.value).toBe('resolved')
    })
  })
})

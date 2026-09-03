import { describe, it, beforeEach, expect, vi } from 'vitest'

import { CaffeineIoC } from '../container.js'
import { Async } from '../decorators/async.js'
import { Configuration } from '../decorators/configuration.js'
import { Injectable } from '../decorators/injectable.js'
import { Interceptor } from '../decorators/interceptor.js'
import { Profile } from '../decorators/profile.js'
import { Provides } from '../decorators/provides.js'
import { UseAsyncFactory } from '../decorators/use_async_factory.js'
import { PostResolutionInterceptor } from '../post_resolution_interceptor.js'

describe('Post Resolution Interceptor', function () {
  const spy1 = vi.fn()
  const spy2 = vi.fn()

  beforeEach(() => {
    spy1.mockReset()
    spy2.mockReset()
  })

  const testInterceptor: PostResolutionInterceptor = (_ctx, instance) => {
    spy1()
    return instance
  }

  @Injectable()
  @Profile('pri-class')
  @Interceptor(testInterceptor)
  @Interceptor((_ctx, instance) => {
    spy2()
    return instance
  })
  class Dep {}

  class Comp {}

  @Configuration()
  @Profile('post-conf')
  class Conf {
    @Provides(Comp)
    @Interceptor(testInterceptor)
    @Interceptor((_ctx, instance) => {
      spy2()
      return instance
    })
    comp() {
      return new Comp()
    }
  }

  describe('using post interceptor on class level', function () {
    it('should register multiple post resolution interceptors', async function () {
      const di = new CaffeineIoC({ profiles: ['pri-class'] })
      await di.init()
      const dep = di.get(Dep)

      expect(dep).toBeInstanceOf(Dep)
      expect(spy1).toHaveBeenCalledTimes(1)
      expect(spy2).toHaveBeenCalledTimes(1)
    })
  })

  describe('using post interceptor on configuration class', function () {
    it('should register multiple post resolution interceptors', async function () {
      const di = new CaffeineIoC({ profiles: ['post-conf'] })
      await di.init()
      const dep = di.get(Comp)

      expect(dep).toBeInstanceOf(Comp)
      expect(spy1).toHaveBeenCalledTimes(1)
      expect(spy2).toHaveBeenCalledTimes(1)
    })
  })

  describe('using post interceptor on async @Provides method', function () {
    it('should call interceptor once during init and receive the resolved instance', async function () {
      class AsyncToken {
        constructor(readonly value: string) {}
      }

      let interceptedInstance: unknown
      const interceptorSpy = vi.fn((_ctx: unknown, instance: AsyncToken) => {
        interceptedInstance = instance
        return instance
      })

      @Configuration()
      @Profile('pri-async-provides')
      class AsyncConf {
        @Async()
        @Provides(AsyncToken)
        @Interceptor(interceptorSpy as PostResolutionInterceptor<AsyncToken>)
        async provideToken(): Promise<AsyncToken> {
          return new AsyncToken('async-value')
        }
      }

      void AsyncConf

      const di = new CaffeineIoC({ profiles: ['pri-async-provides'] })
      await di.init()

      const first = di.get(AsyncToken)
      const second = di.get(AsyncToken)

      expect(interceptorSpy).toHaveBeenCalledTimes(1)
      expect(interceptedInstance).toBeInstanceOf(AsyncToken)
      expect(interceptedInstance).not.toBeInstanceOf(Promise)
      expect((interceptedInstance as AsyncToken).value).toBe('async-value')
      expect(first).toBeInstanceOf(AsyncToken)
      expect((first as AsyncToken).value).toBe('async-value')
      expect(first).toBe(second)
      expect(first).toBe(interceptedInstance)
    })
  })

  describe('using post interceptor on @UseAsyncFactory class', function () {
    it('should call interceptor once during init and receive the resolved instance', async function () {
      class AsyncService {
        constructor(readonly label: string) {}
      }

      let interceptedInstance: unknown
      const interceptorSpy = vi.fn((_ctx: unknown, instance: AsyncService) => {
        interceptedInstance = instance
        return instance
      })

      @Injectable()
      @Profile('pri-async-uaf')
      @Interceptor(interceptorSpy as PostResolutionInterceptor<AsyncService>)
      @UseAsyncFactory(async () => new AsyncService('uaf-value'))
      class AsyncServiceImpl extends AsyncService {
        constructor() {
          super('')
        }
      }

      const di = new CaffeineIoC({ profiles: ['pri-async-uaf'] })
      await di.init()

      const first = di.get(AsyncServiceImpl)
      const second = di.get(AsyncServiceImpl)

      expect(interceptorSpy).toHaveBeenCalledTimes(1)
      expect(interceptedInstance).toBeInstanceOf(AsyncService)
      expect(interceptedInstance).not.toBeInstanceOf(Promise)
      expect((interceptedInstance as AsyncService).label).toBe('uaf-value')
      expect(first).toBeInstanceOf(AsyncService)
      expect((first as AsyncService).label).toBe('uaf-value')
      expect(first).toBe(second)
      expect(first).toBe(interceptedInstance)
    })
  })
})

import 'reflect-metadata'
import { describe, it, beforeAll, expect, vi } from 'vitest'
import { DiCaf } from '../../../container.js'
import { Injectable } from '../injectable.js'
import { Configuration } from '../configuration.js'
import { Provides } from '../provides.js'
import { Interceptor } from '../interceptor.js'
import { Lazy } from '../lazy.js'

describe('Legacy @Interceptor', function () {
  const spy1 = vi.fn()
  const spy2 = vi.fn()
  const spy3 = vi.fn()

  @Lazy()
  @Interceptor((_ctx, instance) => {
    spy1()
    return instance
  })
  @Injectable()
  class InterceptedClass {
    value() {
      return 'intercepted'
    }
  }

  class InterceptedBean {
    value() {
      return 'from-config'
    }
  }

  @Configuration()
  class InterceptorConf {
    @Lazy()
    @Interceptor((_ctx, instance) => {
      spy2()
      return instance
    })
    @Provides(InterceptedBean)
    bean(): InterceptedBean {
      return new InterceptedBean()
    }
  }

  void InterceptorConf

  @Lazy()
  @Interceptor((_ctx, instance) => {
    spy3()
    return instance
  })
  @Interceptor((_ctx, instance) => {
    spy3()
    return instance
  })
  @Injectable()
  class MultiInterceptedClass {}

  const di = new DiCaf()

  beforeAll(async () => {
    await di.init()
  })

  it('calls class-level interceptor on first resolution', function () {
    di.get(InterceptedClass)
    expect(spy1).toHaveBeenCalled()
  })

  it('calls @Provides member-level interceptor on first resolution', function () {
    di.get(InterceptedBean)
    expect(spy2).toHaveBeenCalled()
  })

  it('calls all interceptors when multiple are stacked', function () {
    di.get(MultiInterceptedClass)
    expect(spy3).toHaveBeenCalledTimes(2)
  })

  it('resolved instance is returned correctly after interception', function () {
    const svc = di.get(InterceptedClass)
    expect(svc).toBeInstanceOf(InterceptedClass)
    expect(svc.value()).toBe('intercepted')
  })
})

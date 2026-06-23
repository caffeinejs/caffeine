import 'reflect-metadata'
import { describe, it, beforeAll, afterAll, expect, vi } from 'vitest'
import { DiCaf } from '../../../container.js'
import { PostProcessor } from '../../../post_processor.js'
import { ResolutionContext } from '../../../resolution_context.js'
import { Injectable } from '../injectable.legacy.js'
import { Configuration } from '../configuration.legacy.js'
import { Provides } from '../provides.legacy.js'
import { ByPassPostProcessors } from '../bypass_post_processors.legacy.js'

describe('Legacy @ByPassPostProcessors', function () {
  const spy = vi.fn()

  class TrackingPostProcessor implements PostProcessor {
    beforeInit(_ctx: ResolutionContext, instance: unknown): unknown {
      spy(instance)
      return instance
    }

    afterInit(_ctx: ResolutionContext, instance: unknown): unknown {
      spy(instance)
      return instance
    }
  }

  @Injectable()
  class NormalSvc {
    value() {
      return 'normal'
    }
  }

  @ByPassPostProcessors()
  @Injectable()
  class BypassedSvc {
    value() {
      return 'bypassed'
    }
  }

  class ProviderResult {}

  @Configuration()
  class BppConf {
    @ByPassPostProcessors()
    @Provides(ProviderResult)
    provide(): ProviderResult {
      return new ProviderResult()
    }
  }

  let di: DiCaf

  beforeAll(async () => {
    di = new DiCaf({ decorators: false })
    di.postProcessors.add(new TrackingPostProcessor())
    di.autoWire()
    await di.init()
  })

  afterAll(async () => {
    di.postProcessors.clear()
    await di.dispose()
  })

  it('calls post-processor for normal class during instantiation', function () {
    di.get(NormalSvc)
    const instances = spy.mock.calls.map(args => args[0])
    expect(instances.some(i => i instanceof NormalSvc)).toBe(true)
  })

  it('does not call post-processor for class decorated with @ByPassPostProcessors', function () {
    di.get(BypassedSvc)
    const instances = spy.mock.calls.map(args => args[0])
    expect(instances.some(i => i instanceof BypassedSvc)).toBe(false)
  })

  it('does not call post-processor for @Provides method decorated with @ByPassPostProcessors', function () {
    di.get(ProviderResult)
    const instances = spy.mock.calls.map(args => args[0])
    expect(instances.some(i => i instanceof ProviderResult)).toBe(false)
  })
})

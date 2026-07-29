import { describe, it, expect } from 'vitest'
import { CaffeineIoC } from '../../container.js'
import { PostProcessor } from '../../post_processor.js'
import { ResolutionContext } from '../../resolution_context.js'
import { forceGC } from './_gc.js'
import { trackForCollection } from './_assert_collected.js'

describe('PostProcessor memory', function () {
  it('instances resolved through a post processor are GC-able after dispose()', async function () {
    class Svc {}

    const postProcessor: PostProcessor = {
      beforeInit(_ctx: ResolutionContext, instance: unknown): unknown {
        return instance
      },
      afterInit(_ctx: ResolutionContext, instance: unknown): unknown {
        return instance
      },
    }

    const di = new CaffeineIoC({ decorators: false })
    di.postProcessors.add(postProcessor)
    di.bind(Svc)
      .toSelf()
    await di.init()

    const isCollected = trackForCollection(di.get(Svc)!)

    await di.dispose()
    await forceGC()

    expect(isCollected())
      .toBe(true)
  })

  it('post processor does not retain instances after dispose()', async function () {
    class Svc {}

    const seen: WeakRef<object>[] = []

    const postProcessor: PostProcessor = {
      beforeInit(_ctx: ResolutionContext, instance: unknown): unknown {
        return instance
      },
      afterInit(_ctx: ResolutionContext, instance: unknown): unknown {
        seen.push(new WeakRef(instance as object))
        return instance
      },
    }

    const di = new CaffeineIoC({ decorators: false })
    di.postProcessors.add(postProcessor)
    di.bind(Svc)
      .toSelf()
    await di.init()
    di.get(Svc)

    await di.dispose()
    await forceGC()

    expect(seen.every(ref => ref.deref() === undefined))
      .toBe(true)
  })
})

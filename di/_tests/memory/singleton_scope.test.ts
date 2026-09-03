import { describe, it, expect } from 'vitest'

import { CaffeineIoC } from '../../container.js'
import { trackForCollection } from './_assert_collected.js'
import { forceGC } from './_gc.js'

describe('Singleton scope memory', function () {
  it('releases singleton instance after dispose()', async function () {
    class Svc {}

    const di = new CaffeineIoC({ decorators: false })
    di.bind(Svc, t => t.toSelf())
    await di.init()
    const isCollected = trackForCollection(di.get(Svc)!)

    await di.dispose()
    await forceGC()

    expect(isCollected()).toBe(true)
  })

  it('releases all singleton instances in a dependency graph after dispose()', async function () {
    class Dep {}
    class Mid {}
    class Root {}

    const di = new CaffeineIoC({ decorators: false })
    di.bind(Dep, t => t.toSelf())
    di.bind(Mid, t => t.toSelf())
    di.bind(Root, t => t.toSelf())
    await di.init()

    const depRef = trackForCollection(di.get(Dep)!)
    const midRef = trackForCollection(di.get(Mid)!)
    const rootRef = trackForCollection(di.get(Root)!)

    await di.dispose()
    await forceGC()

    expect(depRef()).toBe(true)
    expect(midRef()).toBe(true)
    expect(rootRef()).toBe(true)
  })

  it('releases instance after resetInstances()', async function () {
    class Svc {}

    const di = new CaffeineIoC({ decorators: false })
    di.bind(Svc, t => t.toSelf())
    await di.init()
    const isCollected = trackForCollection(di.get(Svc)!)

    await di.resetInstances()
    await forceGC()

    expect(isCollected()).toBe(true)
    await di.dispose()
  })

  it('heap does not grow monotonically over repeated create/dispose cycles', async function () {
    class CycleA {}
    class CycleB {}
    class CycleC {}

    const run = async () => {
      const di = new CaffeineIoC({ decorators: false })
      di.bind(CycleA, t => t.toSelf())
      di.bind(CycleB, t => t.toSelf())
      di.bind(CycleC, t => t.toSelf())
      await di.init()
      di.get(CycleA)
      di.get(CycleB)
      di.get(CycleC)
      await di.dispose()
    }

    await run()
    await forceGC()
    const baseline = process.memoryUsage().heapUsed

    for (let i = 0; i < 100; i++) {
      await run()
    }

    await forceGC()
    const delta = process.memoryUsage().heapUsed - baseline
    expect(delta).toBeLessThan(baseline * 0.1)
  })
})

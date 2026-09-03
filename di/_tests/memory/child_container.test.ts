import { describe, it, expect } from 'vitest'
import { CaffeineIoC } from '../../container.js'
import { forceGC } from './_gc.js'
import { trackForCollection } from './_assert_collected.js'

describe('Child container memory', function () {
  it('releases child-only singleton instance after child dispose()', async function () {
    class ChildOnlySvc {}

    const parent = new CaffeineIoC({ decorators: false })
    await parent.init()

    let isCollected!: () => boolean

    const runChild = async () => {
      const child = parent.newChild()
      child.bind(ChildOnlySvc, t => t
        .toSelf())
      await child.init()
      isCollected = trackForCollection(child.get(ChildOnlySvc)!)
      await child.dispose()
    }

    await runChild()
    await forceGC()

    expect(isCollected())
      .toBe(true)
    await parent.dispose()
  })

  it('child container itself is GC-able after dispose()', async function () {
    const parent = new CaffeineIoC({ decorators: false })
    await parent.init()

    let isCollected!: () => boolean

    const runChild = async () => {
      const child = parent.newChild()
      await child.init()
      isCollected = trackForCollection(child)
      await child.dispose()
    }

    await runChild()
    await forceGC()

    expect(isCollected())
      .toBe(true)
    await parent.dispose()
  })

  it('parent singleton instance outlives child dispose()', async function () {
    class SharedSvc {}

    const parent = new CaffeineIoC({ decorators: false })
    parent.bind(SharedSvc, t => t
      .toSelf())
    await parent.init()

    const parentInstance = parent.get(SharedSvc)!
    const isParentCollected = trackForCollection(parentInstance)

    const child = parent.newChild()
    await child.init()
    await child.dispose()

    await forceGC()

    expect(isParentCollected())
      .toBe(false)
    expect(parent.get(SharedSvc))
      .toBe(parentInstance)
    await parent.dispose()
  })

  it('multiple child containers do not leak instances across dispose cycles', async function () {
    class Svc {}

    const parent = new CaffeineIoC({ decorators: false })
    await parent.init()

    const refs: Array<() => boolean> = []

    for (let i = 0; i < 20; i++) {
      const child = parent.newChild()
      child.bind(Svc, t => t
        .toSelf())
      await child.init()
      refs.push(trackForCollection(child.get(Svc)!))
      await child.dispose()
    }

    await forceGC()

    expect(refs.every(r => r()))
      .toBe(true)
    await parent.dispose()
  })
})
